/**
 * SAM 3.1 image segmentation via the Responses API, decoded with Meta's
 * official parser (@meta-sam/parser) — never by hand. One request per noun
 * phrase, as Meta's cookbook recommends.
 *
 * Output is 2D boxes/masks in image space. These are evidence, NOT 3D
 * furniture or world positions.
 */
import { decodeMaskToSVGPath, parseImageStream, recordsOfKind, type ResponsesEvent } from '@meta-sam/parser';
import type { Detection } from '../shared/index.js';
import { config } from '../config.js';
import { AiBudget, metaClient } from './client.js';

// The API streams `response.content_part.done` but not
// `response.output_text.done`, which the parser needs to close a text lane.
// Same normalisation as Meta's cookbook sample.
async function* normalizedEvents(stream: AsyncIterable<unknown>): AsyncIterable<ResponsesEvent> {
  const completed = new Set<string>();
  for await (const raw of stream) {
    const event = raw as { type?: string; item_id?: unknown; output_index?: unknown; content_index?: unknown; part?: { type?: unknown; text?: unknown } | null };
    const lane = `${String(event.item_id)}:${String(event.output_index)}:${String(event.content_index)}`;
    if (event.type === 'response.output_text.done') {
      if (!completed.has(lane)) {
        completed.add(lane);
        yield event as unknown as ResponsesEvent;
      }
      continue;
    }
    yield event as unknown as ResponsesEvent;
    if (event.type === 'response.content_part.done' && !completed.has(lane) && event.part?.type === 'output_text' && typeof event.part.text === 'string') {
      completed.add(lane);
      yield { type: 'response.output_text.done', item_id: event.item_id, output_index: event.output_index, content_index: event.content_index, text: event.part.text } as unknown as ResponsesEvent;
    }
  }
}

export interface SamImageResult {
  detections: Detection[];
  masks: { detectionId: string; svg: string }[];
  diagnostics: string[];
}

export async function segmentConcept(opts: {
  budget: AiBudget;
  mediaId: string;
  dataUrl: string;
  imageSize: { width: number; height: number };
  concept: string;
}): Promise<SamImageResult> {
  const phrase = opts.concept.trim();
  if (!phrase) throw new Error('SAM concept must be a short noun phrase');
  opts.budget.reserve(config.meta.samModel);
  const stream = await metaClient().responses.create({
    model: config.meta.samModel,
    stream: true,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: phrase }, { type: 'input_image', image_url: opts.dataUrl }] }] as any,
  });
  const result = await parseImageStream(normalizedEvents(stream as AsyncIterable<unknown>)).finalResult;
  if (result.outcome.status !== 'completed') {
    throw new Error(`SAM segmentation incomplete: ${result.outcome.reason} ${result.outcome.detail ?? ''}`);
  }
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length) throw new Error(`SAM parser rejected records: ${errors.map((e) => e.message).join('; ')}`);

  const { width, height } = opts.imageSize;
  const at = new Date().toISOString();
  const prov = { method: 'meta:sam-3.1' as const, model: config.meta.samModel, at };
  const boxes = recordsOfKind(result.records, 'box');
  const masks = recordsOfKind(result.records, 'mask');
  const detections: Detection[] = [];
  const maskOut: SamImageResult['masks'] = [];
  const slug = phrase.replace(/\W+/g, '-');
  for (const box of boxes) {
    const id = `${opts.mediaId}-${slug}-${box.objectId}`;
    const mask = masks.find((m) => m.objectId === box.objectId);
    detections.push({
      id,
      mediaId: opts.mediaId,
      concept: phrase,
      box: [box.left / width, box.top / height, box.right / width, box.bottom / height],
      score: box.confidence ?? mask?.confidence ?? null,
      maskKey: mask ? `masks/${id}.svg` : null,
      provenance: prov,
    });
    if (mask) {
      const b = mask.bounds;
      maskOut.push({
        detectionId: id,
        // Mask raster covers `bounds` in source pixels; place it there in a
        // full-image viewBox so the SVG overlays the original photo directly.
        svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><g transform="translate(${b.left} ${b.top}) scale(${(b.right - b.left) / mask.mask.width} ${(b.bottom - b.top) / mask.mask.height})"><path d="${decodeMaskToSVGPath(mask.mask)}" fill="rgba(255,80,40,0.45)"/></g></svg>`,
      });
    }
  }
  return { detections, masks: maskOut, diagnostics: result.diagnostics.map((d) => `${d.severity}: ${d.message}`) };
}
