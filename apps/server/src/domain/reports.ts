import type { Actor, ServerContext } from '../context.js';
import { ApiError } from '../http/errors.js';
import { getRevision } from './attempts.js';
import { getOwnedEvaluation } from './results.js';

export const REPORT_REASONS = ['score_seems_wrong', 'evidence_misquoted', 'rewrite_changed_facts', 'inappropriate_content', 'other'] as const;

/**
 * POST /reports: "This feedback seems wrong". Transcript evidence is copied
 * only when the learner explicitly consents; otherwise only IDs are kept.
 */
export async function createReport(ctx: ServerContext, actor: Actor, input: { evaluation_id: string; reason: string; share_evidence: boolean; note?: string | undefined }) {
  if (!(REPORT_REASONS as readonly string[]).includes(input.reason)) throw ApiError.validation('Unknown report reason.');
  const ev = await getOwnedEvaluation(ctx, actor.userId, input.evaluation_id);
  let snapshot: Record<string, unknown> | null = null;
  if (input.share_evidence) {
    const rev = await getRevision(ctx, ev.attempt_id, ev.transcript_revision);
    snapshot = {
      confirmed_text: rev?.confirmed_text ?? null,
      result: ev.result,
      totals: ev.totals,
      config_version: ev.config_version,
      note: input.note?.slice(0, 500) ?? null,
    };
  } else if (input.note) {
    snapshot = { note: input.note.slice(0, 500) };
  }
  const rows = await ctx.sql<{ id: string; created_at: Date }[]>`
    insert into public.reports (user_id, evaluation_id, reason, share_evidence, evidence_snapshot)
    values (${actor.userId}, ${ev.id}, ${input.reason}, ${input.share_evidence}, ${snapshot ? ctx.sql.json(snapshot as never) : null})
    returning id, created_at`;
  return { report_id: rows[0]!.id, received_at: rows[0]!.created_at.toISOString(), evidence_shared: input.share_evidence };
}
