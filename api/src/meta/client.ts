/**
 * Meta Model API access (https://api.meta.ai/v1) through the OpenAI SDK, as
 * in Meta's own cookbook. Server-side only: the key never leaves this process.
 *
 * Every call goes through a per-run AiBudget so a reconstruction can never
 * make more than AI_MAX_CALLS_PER_RUN requests, and every call has a timeout.
 */
import OpenAI from 'openai';
import { config, metaConfigured } from '../config.js';

export class MetaNotConfiguredError extends Error {
  code = 'META_NOT_CONFIGURED';
  constructor() {
    super('MODEL_API_KEY is not set; live Meta inference is unavailable.');
  }
}

export class AiBudgetExceededError extends Error {
  code = 'AI_BUDGET_EXCEEDED';
}

let cached: OpenAI | null = null;
export function metaClient(): OpenAI {
  if (!metaConfigured()) throw new MetaNotConfiguredError();
  cached ??= new OpenAI({
    baseURL: config.meta.baseUrl,
    apiKey: config.meta.apiKey,
    timeout: config.meta.timeoutMs,
    maxRetries: 1, // bounded retries; the SDK backs off between attempts
  });
  return cached;
}

export interface UsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  byModel: Record<string, number>;
}

export class AiBudget {
  readonly usage: UsageTotals = { calls: 0, inputTokens: 0, outputTokens: 0, byModel: {} };
  constructor(private maxCalls = config.meta.maxCallsPerRun) {}

  reserve(model: string): void {
    if (this.usage.calls >= this.maxCalls) {
      throw new AiBudgetExceededError(`Per-run AI call cap (${this.maxCalls}) reached before calling ${model}.`);
    }
    this.usage.calls++;
    this.usage.byModel[model] = (this.usage.byModel[model] ?? 0) + 1;
  }

  record(usage: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number } | null | undefined) {
    if (!usage) return;
    this.usage.inputTokens += usage.input_tokens ?? usage.prompt_tokens ?? 0;
    this.usage.outputTokens += usage.output_tokens ?? usage.completion_tokens ?? 0;
  }

  summary(): string {
    const models = Object.entries(this.usage.byModel)
      .map(([m, n]) => `${m}×${n}`)
      .join(', ');
    return this.usage.calls
      ? `${this.usage.calls} Meta API calls (${models}); ${this.usage.inputTokens} input / ${this.usage.outputTokens} output tokens`
      : 'No AI calls (fixture data only)';
  }
}

export type JsonSchema = Record<string, unknown>;

/**
 * One multimodal Chat Completions call constrained by a JSON schema.
 * Images must go in the user message (Meta returns 400 otherwise).
 */
export async function museJson<T>(opts: {
  budget: AiBudget;
  model?: string;
  system: string;
  text: string;
  images?: string[]; // data: URLs (jpeg/png/webp/gif)
  schemaName: string;
  schema: JsonSchema;
}): Promise<{ data: T; model: string }> {
  const model = opts.model ?? config.meta.museModel;
  opts.budget.reserve(model);
  const res = await metaClient().chat.completions.create({
    model,
    messages: [
      { role: 'system', content: opts.system },
      {
        role: 'user',
        content: [
          { type: 'text', text: opts.text },
          ...(opts.images ?? []).map((url) => ({ type: 'image_url' as const, image_url: { url } })),
        ],
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: opts.schemaName, schema: opts.schema, strict: true },
    },
  });
  opts.budget.record(res.usage);
  const content = res.choices[0]?.message?.content;
  if (!content) throw new Error(`${model} returned no content (finish_reason=${res.choices[0]?.finish_reason})`);
  return { data: JSON.parse(content) as T, model };
}
