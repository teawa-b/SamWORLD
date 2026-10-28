/**
 * Muse Image redesign visualisations (Responses API, image_generation_call).
 * Output is a 2D concept image — it never changes the 3D scene.
 */
import { config } from '../config.js';
import { AiBudget, metaClient } from './client.js';

export const REDESIGN_PROMPT_VERSION = 'redesign-v1';

export async function redesignRoom(opts: { budget: AiBudget; photoDataUrl: string; instruction: string; roomLabel: string }) {
  opts.budget.reserve(config.meta.imageModel);
  const text =
    `Restyle this photo of the ${opts.roomLabel}: ${opts.instruction}. ` +
    'Keep the room exactly the same shape and size: walls, ceiling, floor plane, windows, doors and camera viewpoint must not move. ' +
    'Only change furniture, finishes and decor. Do not add rooms, windows or doors.';
  const res = await metaClient().responses.create({
    model: config.meta.imageModel,
    store: false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: [{ role: 'user', content: [{ type: 'input_text', text }, { type: 'input_image', image_url: opts.photoDataUrl }] }] as any,
  });
  opts.budget.record(res.usage as never);
  const item = (res.output as { type: string; result?: string }[]).find((o) => o.type === 'image_generation_call');
  if (!item?.result) throw new Error('Muse Image returned no image');
  return { imageBase64: item.result, prompt: text, model: config.meta.imageModel };
}
