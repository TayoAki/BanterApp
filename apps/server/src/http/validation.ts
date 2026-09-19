import { CLIENT_KEY_MAX, CLIENT_KEY_MIN, CONFIRMED_TEXT_MAX, CONFIRMED_TEXT_MIN } from '@marshmemos/contracts';
import { z } from 'zod';
import { ApiError } from './errors.js';

export const uuidSchema = z.string().uuid();
/** Bounded opaque idempotency key, scoped per owner and action server-side. */
export const clientKeySchema = z
  .string()
  .min(CLIENT_KEY_MIN)
  .max(CLIENT_KEY_MAX)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'client_key must be URL-safe');

export const confirmedTextSchema = z
  .string()
  .refine((s) => s.trim().length >= CONFIRMED_TEXT_MIN, 'confirmed_text must not be blank')
  .refine((s) => [...s].length <= CONFIRMED_TEXT_MAX, `confirmed_text exceeds ${CONFIRMED_TEXT_MAX} characters`);

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw ApiError.validation('Invalid request body.', {
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return r.data;
}

export function parseUuidParam(value: string | undefined, name: string): string {
  const r = uuidSchema.safeParse(value);
  if (!r.success) throw ApiError.notFound(`${name} not found.`);
  return r.data.toLowerCase();
}
