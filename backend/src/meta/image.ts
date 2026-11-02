/**
 * Muse Image (Responses API, image_generation_call): the "paint" step of Roomshift.
 *  - surfaceTexture: text → square, seamless texture for a wall/floor/ceiling
 *  - restyleImage:   image + instruction → the same object/scene restyled (image-to-image)
 */
import { config } from '../config.js';
import { AiBudget, metaClient } from './client.js';

export const REDESIGN_PROMPT_VERSION = 'redesign-v1';
export const TEXTURE_PROMPT_VERSION = 'surface-texture-v1';
export const RESTYLE_PROMPT_VERSION = 'object-restyle-v1';

async function generate(budget: AiBudget, content: unknown[]): Promise<{ imageBase64: string; model: string }> {
  budget.reserve(config.meta.imageModel);
  const res = await metaClient().responses.create({
    model: config.meta.imageModel,
    store: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: [{ role: 'user', content }] as any,
  });
  budget.record(res.usage as never);
  const item = (res.output as { type: string; result?: string }[]).find((o) => o.type === 'image_generation_call');
  if (!item?.result) throw new Error(`Muse Image returned no image (output types: ${(res.output as { type: string }[]).map((o) => o.type).join(', ') || 'none'})`);
  return { imageBase64: item.result, model: config.meta.imageModel };
}

/** A square, seamless (tileable) material texture, seen straight on, no perspective or objects. */
export async function surfaceTexture(opts: { budget: AiBudget; description: string; surface: 'wall' | 'floor' | 'ceiling' }) {
  const text =
    `A seamless, tileable ${opts.surface} texture: ${opts.description}. ` +
    'Photographed perfectly flat and straight-on, evenly lit, no perspective, no shadows from objects, no furniture, no people, no text, no border. ' +
    'The left edge must continue into the right edge and the top into the bottom.';
  return { ...(await generate(opts.budget, [{ type: 'input_text', text }])), prompt: text };
}

/** Restyle one object (or a whole photo) while keeping its pose, silhouette and viewpoint. */
export async function restyleImage(opts: { budget: AiBudget; imageDataUrl: string; instruction: string; subject: string }) {
  const text =
    `Restyle the ${opts.subject} in this image: ${opts.instruction}. ` +
    'Keep it the same size, shape, position and camera angle so it still fits the same space. ' +
    'Keep the background plain and uncluttered. Photorealistic.';
  return { ...(await generate(opts.budget, [{ type: 'input_text', text }, { type: 'input_image', image_url: opts.imageDataUrl }])), prompt: text };
}

/** Kept for the old redesign route. */
export async function redesignRoom(opts: { budget: AiBudget; photoDataUrl: string; instruction: string; roomLabel: string }) {
  const r = await restyleImage({ budget: opts.budget, imageDataUrl: opts.photoDataUrl, instruction: `${opts.instruction}. Keep walls, windows and doors where they are`, subject: opts.roomLabel });
  return { imageBase64: r.imageBase64, prompt: r.prompt, model: r.model };
}
