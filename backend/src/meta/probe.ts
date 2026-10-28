/** Startup check: which request shapes the Meta API accepts for the Muse model (5 tiny calls). */
import { config, metaConfigured } from '../config.js';
import { metaClient } from './client.js';

// 8×8 grey PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGNoaGjAihhGJQaLBAAfNjJBkG5ZPQAAAABJRU5ErkJggg==';

export async function probeMeta(log: (msg: string, obj: unknown) => void) {
  if (!metaConfigured()) return;
  const model = config.meta.museModel;
  const c = metaClient();
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
  const tests: Record<string, () => Promise<unknown>> = {
    chatText: () => c.chat.completions.create({ model, messages: [{ role: 'user', content: 'Say ok' }], max_tokens: 5 }),
    chatSystem: () => c.chat.completions.create({ model, messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Say ok' }], max_tokens: 5 }),
    chatSchema: () => c.chat.completions.create({ model, messages: [{ role: 'user', content: 'Return ok true' }], response_format: { type: 'json_schema', json_schema: { name: 'probe', schema, strict: true } } }),
    chatImage: () => c.chat.completions.create({ model, messages: [{ role: 'user', content: [{ type: 'text', text: 'Colour?' }, { type: 'image_url', image_url: { url: PNG } }] }], max_tokens: 5 }),
    responses: () => c.responses.create({ model, input: 'Say ok', max_output_tokens: 16 }),
  };
  const out: Record<string, string> = {};
  for (const [k, fn] of Object.entries(tests)) {
    try {
      await fn();
      out[k] = 'ok';
    } catch (e) {
      const err = e as { status?: number; code?: string; message?: string };
      out[k] = `${err.status ?? ''} ${err.code ?? ''} ${(err.message ?? '').slice(0, 160)}`.trim();
    }
  }
  log('Meta request-shape probe', { model, baseUrl: config.meta.baseUrl, results: out });
}
