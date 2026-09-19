import { z } from 'zod';
import type { Actor, ServerContext } from '../context.js';

export const PRODUCT_EVENTS = [
  'practice_started',
  'recording_finished',
  'transcript_confirmed',
  'feedback_ready',
  'rewrite_ready',
  'playback_started',
  'retry_completed',
  'independent_review_completed',
  'reminder_opted_in',
  'offer_viewed',
  'purchase_verified',
  'feedback_reported',
  'deletion_completed',
] as const;

/** Server-defined events are recorded by the server; the client may only send these. */
export const CLIENT_EVENTS = new Set<string>(['practice_started', 'recording_finished', 'playback_started', 'reminder_opted_in', 'offer_viewed']);

export const telemetrySchema = z.object({
  events: z
    .array(
      z.object({
        event_id: z.string().min(8).max(128),
        name: z.enum(PRODUCT_EVENTS),
        properties: z.record(z.string(), z.union([z.string().max(120), z.number(), z.boolean()])).optional(),
        platform: z.enum(['ios', 'android']).optional(),
      }),
    )
    .max(50),
});

const FORBIDDEN_PROPERTY_KEYS = /transcript|text|email|audio|token|name$/i;

export async function recordClientEvents(ctx: ServerContext, actor: Actor, input: z.infer<typeof telemetrySchema>): Promise<{ accepted: number; rejected: number }> {
  let accepted = 0;
  let rejected = 0;
  for (const e of input.events) {
    if (!CLIENT_EVENTS.has(e.name)) {
      rejected += 1;
      continue;
    }
    const props = Object.fromEntries(Object.entries(e.properties ?? {}).filter(([k]) => !FORBIDDEN_PROPERTY_KEYS.test(k)).slice(0, 20));
    const rows = await ctx.sql<{ id: string }[]>`
      insert into public.telemetry_events (event_id, user_id, name, properties, platform)
      values (${`${actor.userId}:${e.event_id}`}, ${actor.userId}, ${e.name}, ${ctx.sql.json(props as never)}, ${e.platform ?? null})
      on conflict (event_id) do nothing returning id`;
    accepted += rows.length;
  }
  return { accepted, rejected };
}

export async function recordServerEvent(sql: ServerContext['sql'], userId: string | null, name: (typeof PRODUCT_EVENTS)[number], eventId: string, properties: Record<string, string | number | boolean>): Promise<void> {
  await sql`
    insert into public.telemetry_events (event_id, user_id, name, properties)
    values (${eventId}, ${userId}, ${name}, ${sql.json(properties as never)})
    on conflict (event_id) do nothing`;
}
