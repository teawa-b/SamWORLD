/** Small HTTP helpers shared by the route modules. */
import { createReadStream } from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { store } from './store.js';

export const Id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
export const now = () => new Date().toISOString();

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(400, 'BAD_REQUEST', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

// Per-IP token bucket for endpoints that can spend money.
const buckets = new Map<string, { tokens: number; at: number }>();
export function rateLimit(req: FastifyRequest, perMinute: number) {
  const key = `${req.ip}:${req.routeOptions.url}`;
  const b = buckets.get(key) ?? { tokens: perMinute, at: Date.now() };
  b.tokens = Math.min(perMinute, b.tokens + ((Date.now() - b.at) / 60_000) * perMinute);
  b.at = Date.now();
  if (b.tokens < 1) throw new HttpError(429, 'RATE_LIMITED', 'Too many requests; try again shortly.');
  b.tokens -= 1;
  buckets.set(key, b);
}

export function requireProperty(id: string) {
  const p = store.get('properties', parse(Id, id));
  if (!p) throw new HttpError(404, 'NOT_FOUND', 'Property not found');
  return p;
}

export function sendFile(reply: FastifyReply, abs: string, mime: string) {
  reply.header('content-type', mime).header('cache-control', 'public, max-age=300').header('x-content-type-options', 'nosniff');
  if (mime === 'image/svg+xml') reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
  return reply.send(createReadStream(abs));
}

