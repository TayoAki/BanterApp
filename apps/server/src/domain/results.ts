import type { EvaluationDto, PlaybackResponse, RewriteDto, ScoreTotals } from '@marshmemos/contracts';
import type { Evaluation, Rewrite } from '@marshmemos/contracts';
import { frameworkNumber } from '@marshmemos/content';
import type { Actor, ServerContext } from '../context.js';
import { ApiError } from '../http/errors.js';
import { getOwnedAttempt, type AudioAssetRow } from './attempts.js';
import { enqueueJob, type JobRow } from './jobs.js';
import { SESSION_LIMITS } from './sessions.js';

export interface EvaluationRow {
  id: string;
  user_id: string;
  attempt_id: string;
  transcript_revision: number;
  kind: 'attempt' | 'rewrite_candidate' | 'roleplay_session';
  candidate_ordinal: number;
  config_version: string;
  model_id: string | null;
  rubric_version: string;
  framework_id: string;
  result: Evaluation;
  totals: ScoreTotals;
  status: Evaluation['status'];
  source_copy_flag: { example_id: string; note: string } | null;
  is_guided_retry: boolean;
  created_at: Date;
}

export interface RewriteRow {
  id: string;
  user_id: string;
  evaluation_id: string;
  attempt_id: string;
  transcript_revision: number;
  config_version: string;
  status: 'queued' | 'generating' | 'validating' | 'ready' | 'needs_detail' | 'unavailable' | 'rejected';
  result: Rewrite | null;
  rewrite_text: string | null;
  question_for_user: string | null;
  fact_check_state: 'pending' | 'passed' | 'failed' | 'skipped' | null;
  improvement_label: 'stronger_version' | 'another_way' | null;
  error: { code: string; message: string } | null;
  created_at: Date;
}

export async function getOwnedEvaluation(ctx: ServerContext, userId: string, evaluationId: string): Promise<EvaluationRow> {
  const rows = await ctx.sql<EvaluationRow[]>`
    select e.* from public.evaluations e join public.attempts a on a.id = e.attempt_id
     where e.id = ${evaluationId} and e.user_id = ${userId} and a.deleted_at is null`;
  if (!rows[0]) throw ApiError.notFound('Feedback not found.');
  return rows[0];
}

export async function evaluationDto(ctx: ServerContext, row: EvaluationRow): Promise<EvaluationDto> {
  const fw = ctx.catalog.framework(row.framework_id);
  const labels = new Map(fw?.config.criteria.map((c) => [c.id, c]) ?? []);
  const rewrite = (
    await ctx.sql<{ id: string }[]>`select id from public.rewrites where evaluation_id = ${row.id} order by created_at desc limit 1`
  )[0];
  const currentRevision = (await ctx.sql<{ current_revision: number }[]>`select current_revision from public.attempts where id = ${row.attempt_id}`)[0]?.current_revision ?? null;
  return {
    evaluation_id: row.id,
    attempt_id: row.attempt_id,
    transcript_revision: row.transcript_revision,
    framework_id: row.framework_id as EvaluationDto['framework_id'],
    framework_number: frameworkNumber(row.framework_id),
    rubric_version: row.rubric_version,
    status: row.result.status,
    boundary_gate: row.result.boundary_gate,
    confidence: row.result.confidence,
    criteria: row.result.criteria.map((c) => ({
      criterion_id: c.criterion_id,
      label: labels.get(c.criterion_id)?.label ?? c.criterion_id,
      origin: labels.get(c.criterion_id)?.origin ?? 'source_rule',
      score: c.score,
      evidence_quotes: c.evidence_quotes,
      reason: c.reason,
    })),
    strength: row.result.strength,
    priority_improvement: row.result.priority_improvement,
    retry_instruction: row.result.retry_instruction,
    totals: row.totals,
    source_copy_flag: row.source_copy_flag,
    is_guided_retry: row.is_guided_retry,
    rewrite_id: rewrite?.id ?? null,
    current: currentRevision === row.transcript_revision,
    created_at: row.created_at.toISOString(),
  };
}

/** POST /evaluations/:id/rewrite: one rewrite pipeline per evaluated attempt (idempotent). */
export async function requestRewrite(ctx: ServerContext, actor: Actor, evaluationId: string): Promise<{ rewrite: RewriteRow; job: JobRow | null; created: boolean }> {
  const ev = await getOwnedEvaluation(ctx, actor.userId, evaluationId);
  if (ev.kind !== 'attempt') throw ApiError.conflict('Rewrites are generated for attempt feedback only.');
  const attempt = await getOwnedAttempt(ctx, actor.userId, ev.attempt_id);
  const sessionMode = (await ctx.sql<{ mode: string }[]>`select mode from public.practice_sessions where id = ${attempt.session_id}`)[0]?.mode;
  if (sessionMode === 'roleplay') throw ApiError.conflict('Rewrites are not generated for conversation turns.');
  if (attempt.current_revision !== ev.transcript_revision) throw ApiError.conflict('This feedback is for an older transcript revision.');
  if (ev.result.status === 'insufficient_input') throw ApiError.conflict('There is not enough confirmed text to rewrite.');
  if (ev.result.boundary_gate === 'needs_revision') throw ApiError.conflict('Revise the response before requesting a rewrite.');

  const existing = (await ctx.sql<RewriteRow[]>`select * from public.rewrites where evaluation_id = ${ev.id} and config_version = ${ev.config_version}`)[0];
  if (existing) {
    const job = (await ctx.sql<JobRow[]>`select * from public.jobs where stage_key = ${`rewrite:${existing.id}`}`)[0] ?? null;
    return { rewrite: existing, job, created: false };
  }
  const count = await ctx.sql<{ n: number }[]>`select count(*)::int as n from public.rewrites where attempt_id = ${attempt.id} and transcript_revision = ${ev.transcript_revision}`;
  if ((count[0]?.n ?? 0) >= SESSION_LIMITS.rewrites_per_evaluation) throw ApiError.quota('The included rewrite for this attempt is used.');

  return ctx.sql.begin(async (tx) => {
    const rows = await tx<RewriteRow[]>`
      insert into public.rewrites (user_id, evaluation_id, attempt_id, transcript_revision, config_version, status, fact_check_state)
      values (${actor.userId}, ${ev.id}, ${attempt.id}, ${ev.transcript_revision}, ${ev.config_version}, 'queued', 'pending')
      on conflict (evaluation_id, config_version) do nothing
      returning *`;
    const rewrite = rows[0] ?? (await tx<RewriteRow[]>`select * from public.rewrites where evaluation_id = ${ev.id} and config_version = ${ev.config_version}`)[0]!;
    const { job, created } = await enqueueJob(tx as never, {
      userId: actor.userId,
      attemptId: attempt.id,
      sessionId: attempt.session_id,
      type: 'rewrite',
      transcriptRevision: ev.transcript_revision,
      generation: actor.deletionGeneration,
      stageKey: `rewrite:${rewrite.id}`,
      payload: { rewrite_id: rewrite.id, evaluation_id: ev.id },
    });
    return { rewrite, job, created };
  });
}

export async function getOwnedRewrite(ctx: ServerContext, userId: string, rewriteId: string): Promise<RewriteRow> {
  const rows = await ctx.sql<RewriteRow[]>`
    select r.* from public.rewrites r join public.attempts a on a.id = r.attempt_id
     where r.id = ${rewriteId} and r.user_id = ${userId} and a.deleted_at is null`;
  if (!rows[0]) throw ApiError.notFound('Rewrite not found.');
  return rows[0];
}

export async function rewriteDto(ctx: ServerContext, row: RewriteRow): Promise<RewriteDto> {
  const attempt = (await ctx.sql<{ current_revision: number; session_id: string }[]>`select current_revision, session_id from public.attempts where id = ${row.attempt_id}`)[0];
  const stale = attempt ? attempt.current_revision !== row.transcript_revision : true;
  const fw = attempt
    ? ctx.catalog.framework((await ctx.sql<{ framework_id: string }[]>`select framework_id from public.practice_sessions where id = ${attempt.session_id}`)[0]?.framework_id ?? '')
    : null;
  const labels = new Map(fw?.config.criteria.map((c) => [c.id, c.label]) ?? []);
  const asset = (
    await ctx.sql<AudioAssetRow[]>`
      select * from public.audio_assets where rewrite_id = ${row.id} and kind = 'tts' and deleted_at is null order by created_at desc limit 1`
  )[0];
  const speechJob = (await ctx.sql<JobRow[]>`select * from public.jobs where stage_key like ${`speech:${row.id}:%`} order by created_at desc limit 1`)[0];
  let speechState: RewriteDto['speech_state'] = 'none';
  if (asset) {
    if (asset.state === 'ready' && (!asset.expires_at || asset.expires_at > ctx.now())) speechState = 'ready';
    else if (asset.state === 'ready' || asset.state === 'expired') speechState = 'expired';
    else if (asset.state === 'rejected') speechState = 'failed';
    else speechState = 'queued';
  }
  if (speechJob && speechJob.state === 'failed') speechState = 'failed';
  if (speechJob && (speechJob.state === 'queued' || speechJob.state === 'running') && speechState !== 'ready') speechState = 'queued';
  return {
    rewrite_id: row.id,
    evaluation_id: row.evaluation_id,
    transcript_revision: row.transcript_revision,
    status: stale ? 'unavailable' : row.status === 'queued' || row.status === 'generating' ? 'validating' : row.status,
    rewrite_text: stale ? null : row.rewrite_text,
    question_for_user: stale ? null : row.question_for_user,
    new_hypothetical: stale ? null : row.result?.new_hypothetical ?? null,
    changes: stale ? [] : (row.result?.changes ?? []).map((c) => ({ criterion_id: c.criterion_id, label: labels.get(c.criterion_id) ?? c.criterion_id, description: c.description })),
    improvement_label: stale ? null : row.improvement_label,
    speech_asset_id: !stale && speechState === 'ready' && asset ? asset.id : null,
    speech_state: stale ? 'none' : speechState,
    created_at: row.created_at.toISOString(),
  };
}

/** Standard provider voice presets (no cloning). The configured default is always accepted. */
const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
const GEMINI_VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina',
  'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
];

export function supportedVoices(ctx: ServerContext): Set<string> {
  const list = ctx.config.AUDIO_AI_PROVIDER === 'gemini' ? GEMINI_VOICES : OPENAI_VOICES;
  return new Set([...list, ctx.config.TTS_VOICE]);
}

/**
 * POST /rewrites/:id/speech: returns the existing authorized asset or queues
 * exactly one TTS job for the stored validated rewrite text. Regeneration
 * after expiry is bounded to once per rewrite per UTC day.
 */
export async function requestSpeech(ctx: ServerContext, actor: Actor, rewriteId: string, voice: string | undefined): Promise<{ asset: AudioAssetRow | null; job: JobRow | null; created: boolean }> {
  const rewrite = await getOwnedRewrite(ctx, actor.userId, rewriteId);
  if (rewrite.status !== 'ready' || !rewrite.rewrite_text) throw ApiError.conflict('Only a validated rewrite can be spoken.');
  const attempt = await getOwnedAttempt(ctx, actor.userId, rewrite.attempt_id);
  if (attempt.current_revision !== rewrite.transcript_revision) throw ApiError.conflict('This rewrite is for an older transcript revision.');
  const chosenVoice = voice ?? ctx.config.TTS_VOICE;
  if (!supportedVoices(ctx).has(chosenVoice)) throw ApiError.validation('Unsupported voice preset.');

  const ready = (
    await ctx.sql<AudioAssetRow[]>`
      select * from public.audio_assets where rewrite_id = ${rewrite.id} and kind = 'tts' and state = 'ready' and deleted_at is null
         and (expires_at is null or expires_at > now()) and voice_id = ${chosenVoice} order by created_at desc limit 1`
  )[0];
  if (ready) return { asset: ready, job: null, created: false };

  const utcDay = ctx.now().toISOString().slice(0, 10);
  const stageKey = `speech:${rewrite.id}:${chosenVoice}:${ctx.config.TTS_MODEL}:${utcDay}`;
  const existingJob = (await ctx.sql<JobRow[]>`select * from public.jobs where stage_key = ${stageKey}`)[0];
  if (existingJob) return { asset: null, job: existingJob, created: false };

  const generatedToday = await ctx.sql<{ n: number }[]>`
    select count(*)::int as n from public.audio_assets where rewrite_id = ${rewrite.id} and kind = 'tts' and created_at >= ${utcDay}::timestamptz`;
  if ((generatedToday[0]?.n ?? 0) >= SESSION_LIMITS.speech_assets_per_rewrite) {
    throw ApiError.quota('Audio for this rewrite was already generated today. The text stays readable.');
  }
  return ctx.sql.begin(async (tx) => {
    const { job, created } = await enqueueJob(tx as never, {
      userId: actor.userId,
      attemptId: attempt.id,
      sessionId: attempt.session_id,
      type: 'speech',
      transcriptRevision: rewrite.transcript_revision,
      generation: actor.deletionGeneration,
      stageKey,
      payload: { rewrite_id: rewrite.id, voice: chosenVoice },
    });
    return { asset: null, job, created };
  });
}

/** GET /assets/:id/playback: owner-authorized expiring capability if ready and not deleted. */
export async function playback(ctx: ServerContext, actor: Actor, assetId: string): Promise<PlaybackResponse> {
  const asset = (
    await ctx.sql<AudioAssetRow[]>`
      select aa.* from public.audio_assets aa join public.attempts a on a.id = aa.attempt_id
       where aa.id = ${assetId} and aa.user_id = ${actor.userId} and aa.deleted_at is null and a.deleted_at is null`
  )[0];
  if (!asset) throw ApiError.notFound('Audio not found.');
  const playableState = asset.kind === 'tts' ? asset.state === 'ready' : asset.state === 'verified' || asset.state === 'ready';
  if (!playableState) throw ApiError.conflict('Audio is unavailable right now.');
  if (asset.expires_at && asset.expires_at <= ctx.now()) throw new ApiError(410, 'expired', 'This audio has expired.');
  let text: string | null = null;
  if (asset.kind === 'tts' && asset.rewrite_id) {
    // Audio for a superseded transcript revision must never play as the current story.
    const rw = (
      await ctx.sql<{ rewrite_text: string | null; transcript_revision: number; current_revision: number }[]>`
        select r.rewrite_text, r.transcript_revision, a.current_revision from public.rewrites r join public.attempts a on a.id = r.attempt_id where r.id = ${asset.rewrite_id}`
    )[0];
    if (!rw || rw.transcript_revision !== rw.current_revision) throw new ApiError(410, 'superseded', 'This audio belongs to an older transcript revision.');
    text = rw.rewrite_text;
  }
  const signed = await ctx.storage.createSignedRead(asset.object_key, ctx.config.PLAYBACK_URL_TTL_SECONDS);
  return {
    asset_id: asset.id,
    url: signed.url,
    expires_at: signed.expiresAt.toISOString(),
    mime: asset.verified_mime ?? asset.declared_mime ?? 'audio/mp4',
    duration_seconds: asset.verified_duration_seconds ? Number(asset.verified_duration_seconds) : null,
    ai_generated_voice: asset.kind === 'tts',
    text,
  };
}
