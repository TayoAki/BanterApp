import type { AttemptDto, AttemptStage, CreateAttemptRequest, InputMode, UploadRequest, UploadResponse } from '@marshmemos/contracts';
import { ACCEPTED_AUDIO_MIME, RECORDING_HARD_LIMIT_SECONDS, UPLOAD_MAX_BYTES } from '@marshmemos/contracts';
import type { Actor, ServerContext } from '../context.js';
import { ApiError } from '../http/errors.js';
import { impliedBitrate, MAX_PLAUSIBLE_BITRATE, MediaProbeError, MIN_PLAUSIBLE_BITRATE, probeAudio } from '../media/mp4.js';
import { rawAudioKey } from '../storage/types.js';
import { enqueueJob, type JobRow } from './jobs.js';
import { getOwnedSession, SESSION_LIMITS, type SessionRow } from './sessions.js';

export interface AttemptRow {
  id: string;
  user_id: string;
  session_id: string;
  ordinal: number;
  retry_of: string | null;
  input_mode: InputMode;
  is_guided_retry: boolean;
  current_revision: number;
  stage: AttemptStage;
  client_key: string;
  recoverable_error: { code: string; message: string; retryable: boolean; stage: string } | null;
  transcription_job_id: string | null;
  evaluation_job_id: string | null;
  deletion_generation: number;
  created_at: Date;
  deleted_at: Date | null;
}

export interface TranscriptRevisionRow {
  attempt_id: string;
  revision: number;
  user_id: string;
  raw_text: string | null;
  confirmed_text: string | null;
  confirmed_at: Date | null;
  edited: boolean;
  audio_asset_id: string | null;
  provider_meta: Record<string, unknown> | null;
}

export interface AudioAssetRow {
  id: string;
  user_id: string;
  attempt_id: string;
  kind: 'raw' | 'tts';
  bucket: string;
  object_key: string;
  state: 'pending_upload' | 'uploaded' | 'verified' | 'rejected' | 'ready' | 'expired' | 'deleted';
  declared_mime: string | null;
  declared_bytes: number | null;
  verified_mime: string | null;
  verified_bytes: number | null;
  verified_duration_seconds: string | null;
  rewrite_id: string | null;
  expires_at: Date | null;
  deleted_at: Date | null;
  storage_deleted_at: Date | null;
}

export function configVersion(ctx: ServerContext, rubricVersion: string): string {
  return `${ctx.config.PROMPT_CONFIG_VERSION}|rubric:${rubricVersion}|eval:${ctx.config.EVALUATION_MODEL}|rewrite:${ctx.config.REWRITE_MODEL}`;
}

export async function getOwnedAttempt(ctx: ServerContext, userId: string, attemptId: string): Promise<AttemptRow> {
  const rows = await ctx.sql<AttemptRow[]>`
    select * from public.attempts where id = ${attemptId} and user_id = ${userId} and deleted_at is null`;
  if (!rows[0]) throw ApiError.notFound('Attempt not found.');
  return rows[0];
}

export async function getRevision(ctx: ServerContext, attemptId: string, revision: number): Promise<TranscriptRevisionRow | null> {
  const rows = await ctx.sql<TranscriptRevisionRow[]>`
    select * from public.transcript_revisions where attempt_id = ${attemptId} and revision = ${revision}`;
  return rows[0] ?? null;
}

/**
 * POST /sessions/:id/attempts. Idempotent per (owner, client_key). Validates
 * the included retry budget: one guided retry per session, linked to an
 * evaluated attempt in the same session.
 */
export async function createAttempt(ctx: ServerContext, actor: Actor, sessionId: string, req: CreateAttemptRequest): Promise<{ row: AttemptRow; created: boolean }> {
  const session = await getOwnedSession(ctx, actor.userId, sessionId);
  const existing = await ctx.sql<AttemptRow[]>`
    select * from public.attempts where user_id = ${actor.userId} and client_key = ${req.client_key}`;
  if (existing[0]) {
    if (existing[0].session_id !== session.id) throw ApiError.conflict('client_key was used for a different session.');
    return { row: existing[0], created: false };
  }
  const retryOnCompleted = session.status === 'completed' && Boolean(req.retry_of);
  if (session.status !== 'active' && !retryOnCompleted) throw ApiError.conflict(`Session is ${session.status}.`);

  const attempts = await ctx.sql<AttemptRow[]>`
    select * from public.attempts where session_id = ${session.id} and deleted_at is null order by ordinal`;
  const maxAttempts = session.mode === 'roleplay' ? SESSION_LIMITS.roleplay_exchanges + 1 : SESSION_LIMITS.initial_recordings + SESSION_LIMITS.guided_retries;
  if (attempts.length >= maxAttempts) throw ApiError.quota('This session’s included attempts are used.', { max_attempts: maxAttempts });
  const nextOrdinal = (attempts.at(-1)?.ordinal ?? 0) + 1;
  if (req.ordinal !== nextOrdinal) throw ApiError.conflict(`Expected ordinal ${nextOrdinal}.`, { expected_ordinal: nextOrdinal });

  let isGuidedRetry = false;
  if (req.retry_of) {
    const parent = attempts.find((a) => a.id === req.retry_of);
    if (!parent) throw ApiError.notFound('Attempt to retry not found in this session.');
    const evaluated = await ctx.sql<{ id: string }[]>`
      select id from public.evaluations where attempt_id = ${parent.id} and transcript_revision = ${parent.current_revision} and kind = 'attempt' limit 1`;
    if (!evaluated[0]) throw ApiError.conflict('A retry requires feedback on the first attempt.');
    if (session.mode !== 'roleplay' && attempts.some((a) => a.is_guided_retry)) {
      throw ApiError.quota('The included guided retry for this session is used.');
    }
    isGuidedRetry = true;
  } else if (session.mode !== 'roleplay' && attempts.length > 0) {
    throw ApiError.conflict('A second attempt in a session must be a retry (retry_of).');
  }

  const rows = await ctx.sql<AttemptRow[]>`
    insert into public.attempts (user_id, session_id, ordinal, retry_of, input_mode, is_guided_retry, client_key, deletion_generation)
    values (${actor.userId}, ${session.id}, ${nextOrdinal}, ${req.retry_of ?? null}, ${req.input_mode}, ${isGuidedRetry}, ${req.client_key}, ${actor.deletionGeneration})
    returning *`;
  return { row: rows[0]!, created: true };
}

export function mediaBounds() {
  return { max_bytes: UPLOAD_MAX_BYTES, max_seconds: RECORDING_HARD_LIMIT_SECONDS, accepted_mime: [...ACCEPTED_AUDIO_MIME] };
}

/** POST /attempts/:id/upload: single-object expiring upload capability with a server-generated path. */
export async function createUpload(ctx: ServerContext, actor: Actor, attemptId: string, req: UploadRequest): Promise<UploadResponse> {
  const attempt = await getOwnedAttempt(ctx, actor.userId, attemptId);
  if (attempt.input_mode !== 'voice') throw ApiError.conflict('This attempt uses typed input.');
  const retakeable = attempt.current_revision === 0 && ['uploaded', 'transcribing', 'transcript_review'].includes(attempt.stage);
  if (!['created', 'uploading'].includes(attempt.stage) && !retakeable) throw ApiError.conflict(`Attempt is already ${attempt.stage}.`);
  if (req.expected_bytes <= 0) throw ApiError.validation('expected_bytes must be positive.');
  if (retakeable) {
    // "Record again" before any words were confirmed replaces the unconfirmed take:
    // the old raw audio is discarded, its transcription canceled, and the attempt reset.
    await ctx.sql.begin(async (tx) => {
      await tx`update public.jobs set state = 'canceled', error_code = 'retake', finished_at = now(), updated_at = now(), lease_until = null
         where attempt_id = ${attempt.id} and type = 'transcribe' and state in ('queued', 'running', 'failed')`;
      await tx`update public.audio_assets set state = 'deleted', deleted_at = now(), expires_at = now(), updated_at = now() where attempt_id = ${attempt.id} and kind = 'raw' and deleted_at is null`;
      await tx`delete from public.transcript_revisions where attempt_id = ${attempt.id} and revision = 0`;
      await tx`update public.attempts set stage = 'created', transcription_job_id = null, recoverable_error = null, updated_at = now() where id = ${attempt.id} and current_revision = 0`;
    });
    attempt.stage = 'created';
  }
  if (req.expected_bytes > UPLOAD_MAX_BYTES) throw ApiError.tooLarge(`Recording exceeds ${UPLOAD_MAX_BYTES} bytes.`);
  const mime = req.mime.toLowerCase().split(';')[0]!.trim();
  if (!(ACCEPTED_AUDIO_MIME as readonly string[]).includes(mime)) throw ApiError.unprocessable('Unsupported audio type. Record M4A/AAC audio.');
  const ttl = ctx.config.UPLOAD_URL_TTL_SECONDS;

  let asset = (
    await ctx.sql<AudioAssetRow[]>`
      select * from public.audio_assets where attempt_id = ${attempt.id} and kind = 'raw' and state = 'pending_upload' order by created_at desc limit 1`
  )[0];
  if (!asset) {
    const id = crypto.randomUUID();
    const key = rawAudioKey(actor.userId, attempt.id, id);
    const rows = await ctx.sql<AudioAssetRow[]>`
      insert into public.audio_assets (id, user_id, attempt_id, kind, bucket, object_key, state, declared_mime, declared_bytes, expires_at)
      values (${id}, ${actor.userId}, ${attempt.id}, 'raw', ${ctx.config.STORAGE_BUCKET_AUDIO}, ${key}, 'pending_upload', ${mime}, ${req.expected_bytes},
        ${new Date(ctx.now().getTime() + ctx.config.RAW_AUDIO_TTL_HOURS * 3_600_000)})
      returning *`;
    asset = rows[0]!;
  } else {
    await ctx.sql`update public.audio_assets set declared_mime = ${mime}, declared_bytes = ${req.expected_bytes}, updated_at = now() where id = ${asset.id}`;
  }
  const signed = await ctx.storage.createSignedUpload(asset.object_key, { contentType: mime, ttlSeconds: ttl });
  await ctx.sql`update public.attempts set stage = 'uploading', updated_at = now() where id = ${attempt.id} and stage = 'created'`;
  return {
    asset_id: asset.id,
    upload_url: signed.url,
    upload_token: signed.token,
    expires_at: signed.expiresAt.toISOString(),
    method: signed.method,
    headers: signed.headers,
  };
}

/**
 * POST /attempts/:id/upload-complete: verifies ownership, byte size, decoded
 * container/duration, then queues transcription exactly once. Malformed media
 * is rejected before any provider call.
 */
export async function completeUpload(ctx: ServerContext, actor: Actor, attemptId: string, assetId: string): Promise<{ job: JobRow; created: boolean }> {
  const attempt = await getOwnedAttempt(ctx, actor.userId, attemptId);
  const asset = (
    await ctx.sql<AudioAssetRow[]>`select * from public.audio_assets where id = ${assetId} and attempt_id = ${attempt.id} and user_id = ${actor.userId} and kind = 'raw'`
  )[0];
  if (!asset) throw ApiError.notFound('Upload not found.');
  if (asset.state === 'verified' && attempt.transcription_job_id) {
    const job = (await ctx.sql<JobRow[]>`select * from public.jobs where id = ${attempt.transcription_job_id}`)[0];
    if (job && (job.state === 'queued' || job.state === 'running' || job.state === 'succeeded')) return { job, created: false };
    // A failed/canceled transcription resumes the same logical stage (bounded requeue) without re-verifying bytes.
    if (job) {
      return ctx.sql.begin(async (tx) => {
        const requeued = await enqueueJob(tx as never, {
          userId: actor.userId,
          attemptId: attempt.id,
          sessionId: attempt.session_id,
          type: 'transcribe',
          generation: actor.deletionGeneration,
          stageKey: job.stage_key,
          payload: job.payload,
        });
        await tx`update public.attempts set stage = 'transcribing', transcription_job_id = ${requeued.job.id}, recoverable_error = null, updated_at = now() where id = ${attempt.id}`;
        return requeued;
      });
    }
  }
  if (!['pending_upload', 'uploaded'].includes(asset.state)) throw ApiError.conflict(`Upload is ${asset.state}.`);

  const info = await ctx.storage.head(asset.object_key);
  if (!info) throw ApiError.conflict('No uploaded object was found. Upload the recording, then retry.');
  if (info.bytes <= 0) throw ApiError.unprocessable('The uploaded recording is empty.');
  if (info.bytes > UPLOAD_MAX_BYTES) {
    await rejectAsset(ctx, asset.id, attempt.id, 'too_large', 'Recording exceeds the size limit.');
    throw ApiError.tooLarge('Recording exceeds the size limit.');
  }
  const bytes = await ctx.storage.download(asset.object_key);
  let probe;
  try {
    probe = probeAudio(bytes);
  } catch (err) {
    const message = err instanceof MediaProbeError ? err.message : 'The recording could not be read.';
    await rejectAsset(ctx, asset.id, attempt.id, 'invalid_media', message);
    throw ApiError.unprocessable(message);
  }
  if (probe.duration_seconds > RECORDING_HARD_LIMIT_SECONDS + 5) {
    await rejectAsset(ctx, asset.id, attempt.id, 'too_long', `Recording exceeds ${RECORDING_HARD_LIMIT_SECONDS} seconds.`);
    throw ApiError.unprocessable(`Recording exceeds ${RECORDING_HARD_LIMIT_SECONDS} seconds.`);
  }
  if (probe.duration_seconds < 0.5) {
    await rejectAsset(ctx, asset.id, attempt.id, 'too_short', 'The recording is too short to transcribe.');
    throw ApiError.unprocessable('The recording is too short to transcribe.');
  }
  // A container that declares a short duration for a large payload is not trusted (billing is per audio minute).
  const bitrate = impliedBitrate(info.bytes, probe.duration_seconds);
  if (bitrate < MIN_PLAUSIBLE_BITRATE || bitrate > MAX_PLAUSIBLE_BITRATE) {
    await rejectAsset(ctx, asset.id, attempt.id, 'implausible_media', 'The recording’s declared length does not match its size.');
    throw ApiError.unprocessable('The recording’s declared length does not match its size.');
  }
  const verifiedMime = probe.container === 'mp3' ? 'audio/mpeg' : 'audio/mp4';

  return ctx.sql.begin(async (tx) => {
    await tx`
      update public.audio_assets set state = 'verified', verified_mime = ${verifiedMime}, verified_bytes = ${info.bytes},
        verified_duration_seconds = ${probe.duration_seconds.toFixed(3)}, updated_at = now() where id = ${asset.id}`;
    const { job, created } = await enqueueJob(tx as never, {
      userId: actor.userId,
      attemptId: attempt.id,
      sessionId: attempt.session_id,
      type: 'transcribe',
      generation: actor.deletionGeneration,
      stageKey: `transcribe:${attempt.id}:${asset.id}`,
      payload: { asset_id: asset.id, duration_seconds: probe.duration_seconds, mime: verifiedMime },
    });
    await tx`update public.attempts set stage = 'transcribing', transcription_job_id = ${job.id}, recoverable_error = null, updated_at = now() where id = ${attempt.id}`;
    return { job, created };
  });
}

async function rejectAsset(ctx: ServerContext, assetId: string, attemptId: string, code: string, message: string) {
  await ctx.sql.begin(async (tx) => {
    await tx`update public.audio_assets set state = 'rejected', updated_at = now() where id = ${assetId}`;
    await tx`update public.attempts set stage = 'created', recoverable_error = ${tx.json({ code, message, retryable: false, stage: 'upload' })}, updated_at = now() where id = ${attemptId}`;
  });
}

/**
 * PUT /attempts/:id/transcript. Creates an immutable confirmed revision and
 * supersedes dependent work from older revisions. First confirmation uses
 * expected_revision 0; one correction (revision 2) is included.
 */
export async function confirmTranscript(
  ctx: ServerContext,
  actor: Actor,
  attemptId: string,
  req: { expected_revision: number; confirmed_text: string },
): Promise<{ attempt: AttemptRow; revision: TranscriptRevisionRow }> {
  const attempt = await getOwnedAttempt(ctx, actor.userId, attemptId);
  if (['transcribing', 'uploading'].includes(attempt.stage) && attempt.input_mode === 'voice') {
    throw ApiError.conflict('Transcription is still running.');
  }
  if (attempt.current_revision !== req.expected_revision) {
    throw ApiError.conflict('The transcript changed since you loaded it.', { current_revision: attempt.current_revision });
  }
  if (attempt.current_revision >= 1 + SESSION_LIMITS.transcript_corrections) {
    throw ApiError.quota('The included transcript correction for this attempt is used.');
  }
  const text = req.confirmed_text.trim();
  const raw = await getRevision(ctx, attempt.id, 0);
  // A voice attempt whose transcription never produced words (failed, or the
  // learner chose "Type instead") may continue as typed input.
  const typedFallback = attempt.input_mode === 'voice' && !raw;
  if (typedFallback && !['created', 'uploading', 'uploaded'].includes(attempt.stage)) throw ApiError.conflict('No transcript to confirm yet.');
  const previous = attempt.current_revision > 0 ? await getRevision(ctx, attempt.id, attempt.current_revision) : raw;
  const edited = previous ? (previous.confirmed_text ?? previous.raw_text ?? '') !== text : true;
  const newRevision = attempt.current_revision + 1;

  const result = await ctx.sql.begin(async (tx) => {
    if (!raw) {
      await tx`
        insert into public.transcript_revisions (attempt_id, revision, user_id, raw_text, confirmed_text, edited, provider_meta)
        values (${attempt.id}, 0, ${actor.userId}, ${text}, null, false, ${tx.json({ input_mode: typedFallback ? 'typed_fallback' : 'typed' })})`;
      if (typedFallback) {
        await tx`update public.jobs set state = 'canceled', error_code = 'typed_fallback', finished_at = now(), updated_at = now(), lease_until = null
           where attempt_id = ${attempt.id} and type = 'transcribe' and state in ('queued', 'running', 'failed')`;
      }
    }
    const inserted = await tx<TranscriptRevisionRow[]>`
      insert into public.transcript_revisions (attempt_id, revision, user_id, raw_text, confirmed_text, confirmed_at, edited, audio_asset_id)
      values (${attempt.id}, ${newRevision}, ${actor.userId}, ${raw?.raw_text ?? text}, ${text}, now(), ${edited}, ${raw?.audio_asset_id ?? null})
      returning *`;
    // Older dependent work (evaluation/rewrite/speech) no longer applies to the confirmed words.
    await tx`
      update public.jobs set state = 'canceled', error_code = 'superseded_revision', finished_at = now(), updated_at = now(), lease_until = null
       where attempt_id = ${attempt.id} and type in ('evaluate', 'rewrite', 'speech') and state in ('queued', 'running')`;
    // Synthesized audio of the old story expires now so the sweep removes the objects.
    await tx`update public.audio_assets set expires_at = now(), updated_at = now() where attempt_id = ${attempt.id} and kind = 'tts' and deleted_at is null`;
    const updated = await tx<AttemptRow[]>`
      update public.attempts set current_revision = ${newRevision}, stage = 'transcript_review', evaluation_job_id = null, recoverable_error = null, updated_at = now()
       where id = ${attempt.id} and current_revision = ${req.expected_revision} returning *`;
    if (!updated[0]) throw ApiError.conflict('The transcript changed concurrently.');
    return { attempt: updated[0], revision: inserted[0]! };
  });
  return result;
}

/** POST /attempts/:id/evaluate: 202 evaluation job for the confirmed revision (idempotent). */
export async function requestEvaluation(ctx: ServerContext, actor: Actor, attemptId: string, revision: number): Promise<{ job: JobRow; created: boolean; existingEvaluationId: string | null }> {
  const attempt = await getOwnedAttempt(ctx, actor.userId, attemptId);
  if (revision < 1 || revision !== attempt.current_revision) {
    throw ApiError.conflict('Evaluate the current confirmed revision.', { current_revision: attempt.current_revision });
  }
  const session = await getOwnedSession(ctx, actor.userId, attempt.session_id);
  if (session.mode === 'roleplay') throw ApiError.conflict('Conversation turns are assessed once at the end of the roleplay.');
  const cfg = configVersion(ctx, session.framework_version);
  const existing = await ctx.sql<{ id: string }[]>`
    select id from public.evaluations where attempt_id = ${attempt.id} and transcript_revision = ${revision} and config_version = ${cfg} and kind = 'attempt'`;
  return ctx.sql.begin(async (tx) => {
    const { job, created } = await enqueueJob(tx as never, {
      userId: actor.userId,
      attemptId: attempt.id,
      sessionId: attempt.session_id,
      type: 'evaluate',
      transcriptRevision: revision,
      generation: actor.deletionGeneration,
      stageKey: `evaluate:${attempt.id}:${revision}:${cfg}`,
      payload: { config_version: cfg },
    });
    if (created) {
      await tx`update public.attempts set stage = 'evaluating', evaluation_job_id = ${job.id}, recoverable_error = null, updated_at = now() where id = ${attempt.id}`;
    }
    return { job, created, existingEvaluationId: existing[0]?.id ?? null };
  });
}

export async function attemptDto(ctx: ServerContext, attempt: AttemptRow): Promise<AttemptDto> {
  const raw = await getRevision(ctx, attempt.id, 0);
  const current = attempt.current_revision > 0 ? await getRevision(ctx, attempt.id, attempt.current_revision) : null;
  const evaluations = await ctx.sql<{ id: string; transcript_revision: number }[]>`
    select id, transcript_revision from public.evaluations where attempt_id = ${attempt.id} and kind = 'attempt' order by created_at`;
  const currentEval = evaluations.filter((e) => e.transcript_revision === attempt.current_revision).at(-1) ?? null;
  const meta = (raw?.provider_meta ?? null) as { duration_seconds?: number; language?: string; low_content?: boolean } | null;
  return {
    attempt_id: attempt.id,
    session_id: attempt.session_id,
    ordinal: attempt.ordinal,
    retry_of: attempt.retry_of,
    input_mode: attempt.input_mode,
    stage: attempt.stage,
    current_revision: attempt.current_revision,
    media_bounds: mediaBounds(),
    transcript: {
      raw_text: raw?.raw_text ?? null,
      confirmed_text: current?.confirmed_text ?? null,
      confirmed_revision: current ? current.revision : null,
      provider_meta: meta
        ? { duration_seconds: meta.duration_seconds ?? null, language: meta.language ?? null, low_content: Boolean(meta.low_content) }
        : null,
    },
    evaluation_id: currentEval?.id ?? null,
    evaluation_ids: evaluations.map((e) => e.id),
    recoverable_error: attempt.recoverable_error,
    transcription_job_id: attempt.transcription_job_id,
    evaluation_job_id: attempt.evaluation_job_id,
    created_at: attempt.created_at.toISOString(),
  };
}

export type { SessionRow };
