import { createHash } from 'node:crypto';
import {
  deterministicFactSignals,
  factSignalsBlockRewrite,
  rewriteImprovementVerdict,
  validatePartnerReply,
  validateRewrite,
  validateRewriteVerification,
  type Rewrite,
} from '@marshmemos/contracts';
import type { ServerContext } from '../context.js';
import type { Db, Tx } from '../db/client.js';
import { commitSession } from '../domain/allowance.js';
import type { AttemptRow, AudioAssetRow, TranscriptRevisionRow } from '../domain/attempts.js';
import { applyEntitlementSnapshot } from '../domain/entitlements.js';
import type { JobRow } from '../domain/jobs.js';
import { recordEvidence } from '../domain/progress.js';
import type { EvaluationRow, RewriteRow } from '../domain/results.js';
import { markSessionCompleted, type RoleplayState, type SessionRow } from '../domain/sessions.js';
import { recordServerEvent } from '../domain/telemetry.js';
import { probeAudio } from '../media/mp4.js';
import { ttsAudioKey } from '../storage/types.js';
import { evaluateSubject, frameworkOrThrow, InvalidModelOutputError } from './pipeline.js';

export interface StageOutcome {
  resultId: string | null;
  resultKind: 'transcript_revision' | 'evaluation' | 'rewrite' | 'asset' | 'roleplay_turn' | null;
  checkpoint?: Record<string, unknown>;
}

export class StaleJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleJobError';
  }
}

/**
 * Commit guard shared by every handler: inside one transaction, re-lock the
 * job (must still hold the lease), verify the attempt is alive with the same
 * deletion generation and revision, then write the artifact and mark the job
 * succeeded. Anything stale is discarded without side effects.
 */
async function commitStage(
  ctx: ServerContext,
  job: JobRow,
  checks: { attemptId?: string | null; revision?: number | null },
  write: (tx: Tx) => Promise<StageOutcome>,
): Promise<StageOutcome> {
  return ctx.sql.begin(async (tx) => {
    // Lock order: attempt, then job (deletion locks the attempt first too), so
    // a delete racing a commit never deadlocks.
    if (checks.attemptId) {
      const a = await tx<{ deleted_at: Date | null; current_revision: number; deletion_generation: number }[]>`
        select deleted_at, current_revision, deletion_generation from public.attempts where id = ${checks.attemptId} for update`;
      if (!a[0] || a[0].deleted_at) throw new StaleJobError('attempt deleted');
      if (checks.revision !== undefined && checks.revision !== null && a[0].current_revision !== checks.revision) {
        throw new StaleJobError('transcript revision superseded');
      }
    }
    const locked = await tx<JobRow[]>`select * from public.jobs where id = ${job.id} for update`;
    const j = locked[0];
    if (!j || j.state !== 'running' || j.worker_id !== ctx.config.workerId) throw new StaleJobError('job lost its lease before commit');
    const owner = await tx<{ deletion_generation: number; account_state: string }[]>`select deletion_generation, account_state from public.profiles where id = ${job.user_id}`;
    if (!owner[0] || owner[0].account_state !== 'active' || owner[0].deletion_generation !== job.generation) {
      throw new StaleJobError('owner is deleting or generation changed');
    }
    const outcome = await write(tx);
    const done = await tx<{ complete_job: boolean }[]>`
      select public.complete_job(${job.id}, ${ctx.config.workerId}, ${outcome.resultId}, ${outcome.resultKind}, ${tx.json((outcome.checkpoint ?? {}) as never)})`;
    if (!done[0]?.complete_job) throw new StaleJobError('complete_job refused (lease lost)');
    return outcome;
  });
}

export async function saveCheckpoint(sql: Db, job: JobRow, patch: Record<string, unknown>): Promise<void> {
  await sql`update public.jobs set checkpoint = checkpoint || ${sql.json(patch as never)}, updated_at = now() where id = ${job.id} and worker_id = ${job.worker_id}`;
}

async function loadAttempt(sql: Db, attemptId: string): Promise<AttemptRow> {
  const rows = await sql<AttemptRow[]>`select * from public.attempts where id = ${attemptId}`;
  if (!rows[0] || rows[0].deleted_at) throw new StaleJobError('attempt missing or deleted');
  return rows[0];
}

async function loadSession(sql: Db, sessionId: string): Promise<SessionRow> {
  const rows = await sql<SessionRow[]>`select *, quota_window_date::text as quota_window_date from public.practice_sessions where id = ${sessionId}`;
  if (!rows[0] || rows[0].deleted_at) throw new StaleJobError('session missing or deleted');
  return rows[0];
}

async function loadConfirmed(sql: Db, attemptId: string, revision: number): Promise<TranscriptRevisionRow> {
  const rows = await sql<TranscriptRevisionRow[]>`select * from public.transcript_revisions where attempt_id = ${attemptId} and revision = ${revision}`;
  if (!rows[0]?.confirmed_text) throw new StaleJobError('confirmed revision missing');
  return rows[0];
}

// ---------------------------------------------------------------------------
// transcribe
// ---------------------------------------------------------------------------
export async function handleTranscribe(ctx: ServerContext, job: JobRow): Promise<StageOutcome> {
  const attempt = await loadAttempt(ctx.sql, job.attempt_id!);
  const existing = await ctx.sql<{ revision: number }[]>`select revision from public.transcript_revisions where attempt_id = ${attempt.id} and revision = 0`;
  const assetId = String(job.payload['asset_id']);
  const asset = (await ctx.sql<AudioAssetRow[]>`select * from public.audio_assets where id = ${assetId} and attempt_id = ${attempt.id}`)[0];
  if (!asset || asset.deleted_at) throw new StaleJobError('audio asset missing');
  if (existing[0]) {
    return commitStage(ctx, job, { attemptId: attempt.id }, async () => ({ resultId: attempt.id, resultKind: 'transcript_revision' }));
  }

  let text = typeof job.checkpoint['transcript'] === 'string' ? (job.checkpoint['transcript'] as string) : null;
  let meta = (job.checkpoint['provider_meta'] as Record<string, unknown> | undefined) ?? null;
  if (text === null) {
    const bytes = await ctx.storage.download(asset.object_key);
    const result = await ctx.providers.transcriber.transcribe(
      { bytes, filename: asset.object_key.split('/').pop() ?? 'recording.m4a', mime: asset.verified_mime ?? 'audio/mp4', languageHint: 'en' },
      { timeoutMs: ctx.config.TIMEOUT_TRANSCRIBE_MS },
    );
    text = result.text;
    meta = {
      ...result.provider_meta,
      model: result.model,
      language: result.language,
      duration_seconds: result.duration_seconds ?? (asset.verified_duration_seconds ? Number(asset.verified_duration_seconds) : null),
    };
    await saveCheckpoint(ctx.sql, job, { transcript: text, provider_meta: meta });
  }
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lowContent = words.length < 3;
  const finalMeta = { ...(meta ?? {}), low_content: lowContent, input_mode: 'voice' };

  return commitStage(ctx, job, { attemptId: attempt.id }, async (tx) => {
    await tx`
      insert into public.transcript_revisions (attempt_id, revision, user_id, raw_text, confirmed_text, edited, audio_asset_id, provider_meta)
      values (${attempt.id}, 0, ${attempt.user_id}, ${text}, null, false, ${asset.id}, ${tx.json(finalMeta as never)})
      on conflict (attempt_id, revision) do nothing`;
    await tx`update public.attempts set stage = 'transcript_review', recoverable_error = null, updated_at = now() where id = ${attempt.id} and stage in ('transcribing', 'uploaded', 'uploading')`;
    return { resultId: attempt.id, resultKind: 'transcript_revision', checkpoint: { transcript_words: words.length } };
  });
}

// ---------------------------------------------------------------------------
// evaluate (attempt)
// ---------------------------------------------------------------------------
export async function handleEvaluate(ctx: ServerContext, job: JobRow): Promise<StageOutcome> {
  const attempt = await loadAttempt(ctx.sql, job.attempt_id!);
  const revision = job.transcript_revision!;
  if (attempt.current_revision !== revision) throw new StaleJobError('revision superseded before evaluation');
  const session = await loadSession(ctx.sql, attempt.session_id);
  const confirmed = await loadConfirmed(ctx.sql, attempt.id, revision);
  const cfg = String(job.payload['config_version']);
  const existing = (await ctx.sql<EvaluationRow[]>`
    select * from public.evaluations where attempt_id = ${attempt.id} and transcript_revision = ${revision} and config_version = ${cfg} and kind = 'attempt'`)[0];
  if (existing) return commitStage(ctx, job, { attemptId: attempt.id, revision }, async () => ({ resultId: existing.id, resultKind: 'evaluation' }));

  const fw = frameworkOrThrow(ctx, session.framework_id);
  const promptEntry = ctx.catalog.promptsById.get(session.prompt_id);
  if (!promptEntry) throw new InvalidModelOutputError('content', 'prompt_missing', 'Prompt is not in the catalog.');
  const evaluated = await evaluateSubject(
    ctx,
    {
      framework: fw,
      prompt: { id: promptEntry.seed.id, text: promptEntry.seed.prompt, kind: promptEntry.seed.kind, criterion_ids: promptEntry.seed.criterion_ids },
      confirmedText: confirmed.confirmed_text!,
      transcriptRevision: revision,
      inputMode: attempt.input_mode,
      isGuidedRetry: attempt.is_guided_retry,
      partnerTurns: null,
    },
    { cachedRaw: job.checkpoint['raw_evaluation'] },
  );
  await saveCheckpoint(ctx.sql, job, { raw_evaluation: evaluated.evaluation });

  const profile = (await ctx.sql<{ timezone: string }[]>`select timezone from public.profiles where id = ${attempt.user_id}`)[0];
  const lesson = session.lesson_id ? { id: session.lesson_id, version: session.lesson_version ?? 1 } : null;

  return commitStage(ctx, job, { attemptId: attempt.id, revision }, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      insert into public.evaluations (user_id, attempt_id, transcript_revision, kind, candidate_ordinal, config_version, model_id, prompt_template_version,
        rubric_version, framework_id, result, totals, status, source_copy_flag, is_guided_retry, provider_meta)
      values (${attempt.user_id}, ${attempt.id}, ${revision}, 'attempt', 0, ${cfg}, ${evaluated.meta.model}, ${evaluated.meta.prompt_template_version},
        ${fw.config.rubric_version}, ${fw.config.id}, ${tx.json(evaluated.evaluation as never)}, ${tx.json(evaluated.totals as never)},
        ${evaluated.evaluation.status}, ${evaluated.sourceCopy ? tx.json(evaluated.sourceCopy as never) : null}, ${attempt.is_guided_retry},
        ${tx.json({ latency_ms: evaluated.meta.latency_ms, repaired: evaluated.repaired, usage: evaluated.meta.usage ?? null } as never)})
      on conflict (attempt_id, transcript_revision, config_version, kind, candidate_ordinal) do update set id = public.evaluations.id
      returning id`;
    const evaluationId = rows[0]!.id;
    await tx`update public.attempts set stage = 'feedback', recoverable_error = null, updated_at = now() where id = ${attempt.id}`;
    await recordEvidence(tx as unknown as Db, {
      userId: attempt.user_id,
      frameworkId: fw.config.id,
      rubricVersion: fw.config.rubric_version,
      attemptId: attempt.id,
      evaluationId,
      promptId: session.prompt_id,
      sessionId: session.id,
      lessonId: lesson?.id ?? null,
      lessonVersion: lesson?.version ?? null,
      guided: attempt.is_guided_retry,
      masteryQualifies: evaluated.totals.mastery_qualifies,
      status: evaluated.evaluation.status,
      confidence: evaluated.evaluation.confidence,
      sourceCopy: evaluated.sourceCopy !== null,
      displayedTotal: evaluated.totals.displayed_total,
      timezone: profile?.timezone ?? 'UTC',
      occurredAt: ctx.now(),
    });
    // Finalize the allowance once on valid feedback; a guided retry rides the existing reservation.
    await commitSession(tx as unknown as Db, session.id);
    if (!attempt.is_guided_retry) await markSessionCompleted(tx as unknown as Db, session.id);
    await recordServerEvent(tx as unknown as Db, attempt.user_id, attempt.is_guided_retry ? 'retry_completed' : 'feedback_ready', `feedback:${evaluationId}`, {
      framework_id: fw.config.id,
      rubric_version: fw.config.rubric_version,
      status: evaluated.evaluation.status,
      guided: attempt.is_guided_retry,
    });
    return { resultId: evaluationId, resultKind: 'evaluation', checkpoint: { evaluation_id: evaluationId } };
  });
}

// ---------------------------------------------------------------------------
// rewrite → structural validation → deterministic signals → verifier → re-evaluation
// ---------------------------------------------------------------------------
export async function handleRewrite(ctx: ServerContext, job: JobRow): Promise<StageOutcome> {
  const rewriteId = String(job.payload['rewrite_id']);
  const rewrite = (await ctx.sql<RewriteRow[]>`select * from public.rewrites where id = ${rewriteId}`)[0];
  if (!rewrite) throw new StaleJobError('rewrite row missing');
  if (rewrite.status === 'ready' || rewrite.status === 'needs_detail' || rewrite.status === 'unavailable') {
    return commitStage(ctx, job, { attemptId: rewrite.attempt_id, revision: rewrite.transcript_revision }, async () => ({ resultId: rewrite.id, resultKind: 'rewrite' }));
  }
  const attempt = await loadAttempt(ctx.sql, rewrite.attempt_id);
  if (attempt.current_revision !== rewrite.transcript_revision) throw new StaleJobError('revision superseded before rewrite');
  const session = await loadSession(ctx.sql, attempt.session_id);
  const confirmed = await loadConfirmed(ctx.sql, attempt.id, rewrite.transcript_revision);
  const evaluation = (await ctx.sql<EvaluationRow[]>`select * from public.evaluations where id = ${rewrite.evaluation_id}`)[0];
  if (!evaluation) throw new StaleJobError('evaluation missing');
  const fw = frameworkOrThrow(ctx, session.framework_id);
  const promptEntry = ctx.catalog.promptsById.get(session.prompt_id);
  if (!promptEntry) throw new InvalidModelOutputError('content', 'prompt_missing', 'Prompt is not in the catalog.');
  const criteria = fw.config.criteria.filter((c) => promptEntry.seed.criterion_ids.includes(c.id));
  const fictional = promptEntry.seed.kind === 'fictional_roleplay';
  const transcript = confirmed.confirmed_text!;
  await ctx.sql`update public.rewrites set status = 'generating', updated_at = now() where id = ${rewrite.id} and status = 'queued'`;

  const rewriteCtx = {
    framework: fw.config,
    assignedCriterionIds: promptEntry.seed.criterion_ids,
    expectedRevision: rewrite.transcript_revision,
    confirmedTranscript: transcript,
    allowedContextText: promptEntry.seed.prompt,
    fictional,
  };
  const targetIds = evaluation.result.criteria.filter((c) => c.score !== null && c.score < 2).map((c) => c.criterion_id);
  const deficient = criteria.find((c) => targetIds.includes(c.id)) ?? criteria[criteria.length - 1]!;
  const fallbackQuestion = `What is one true detail from this moment that shows “${deficient.label.toLowerCase()}”?`;

  type Final = {
    status: 'ready' | 'needs_detail' | 'unavailable';
    result: Rewrite | null;
    text: string | null;
    question: string | null;
    factCheck: 'passed' | 'failed' | 'skipped';
    verification: unknown;
    signals: unknown;
    candidateEvaluationId: string | null;
    candidate: { evaluation: unknown; totals: unknown; status: string; model: string; template: string; latency: number; ordinal: number } | null;
    label: 'stronger_version' | 'another_way' | null;
    error: { code: string; message: string } | null;
  };

  let final: Final | null = null;
  let lastFailure: { code: string; message: string } | null = null;
  let generationAttempts = Number(job.checkpoint['generation_attempts'] ?? 0);
  const maxGenerations = 2;

  while (final === null && generationAttempts < maxGenerations) {
    generationAttempts += 1;
    const repair = lastFailure
      ? {
          code: lastFailure.code,
          note: 'The previous rewrite was rejected. Preserve only facts present in the confirmed transcript; do not add people, reactions, numbers, places, or new feelings. Cite exact substrings for preserved facts.',
          details: { message: lastFailure.message },
        }
      : undefined;
    const generated = await ctx.providers.rewriter.rewrite(
      {
        framework: fw.config,
        criteria,
        examples: fw.examples.map((e) => e.example),
        rubric_version: fw.config.rubric_version,
        prompt: { id: promptEntry.seed.id, text: promptEntry.seed.prompt, kind: promptEntry.seed.kind },
        confirmed_transcript: transcript,
        transcript_revision: rewrite.transcript_revision,
        evaluation: evaluation.result,
        fictional,
        scenario_context: fictional ? promptEntry.seed.prompt : null,
      },
      { timeoutMs: ctx.config.TIMEOUT_REWRITE_MS, ...(repair ? { repair } : {}) },
    );
    await saveCheckpoint(ctx.sql, job, { generation_attempts: generationAttempts });
    const structural = validateRewrite(generated.raw, rewriteCtx);
    if (!structural.ok) {
      lastFailure = { code: structural.code, message: structural.message };
      continue;
    }
    const rw = structural.value;
    if (rw.status !== 'ready' || !rw.rewrite_text) {
      final = {
        status: rw.status,
        result: rw,
        text: null,
        question: rw.status === 'needs_detail' ? rw.question_for_user : null,
        factCheck: 'skipped',
        verification: null,
        signals: null,
        candidateEvaluationId: null,
        candidate: null,
        label: null,
        error: null,
      };
      break;
    }
    const signals = deterministicFactSignals(transcript, rw.rewrite_text, promptEntry.seed.prompt);
    if (!fictional && factSignalsBlockRewrite(signals)) {
      lastFailure = { code: 'introduced_facts', message: `Introduced numbers/entities: ${[...signals.introduced_numbers, ...signals.introduced_entities].join(', ')}` };
      continue;
    }
    const verifierRaw = await ctx.providers.verifier.verify(
      { confirmed_transcript: transcript, rewrite_text: rw.rewrite_text, task: promptEntry.seed.prompt, criteria, fictional, scenario_context: fictional ? promptEntry.seed.prompt : null },
      { timeoutMs: ctx.config.TIMEOUT_VERIFY_MS },
    );
    const verification = validateRewriteVerification(verifierRaw.raw, rw.rewrite_text);
    if (!verification.ok) {
      lastFailure = { code: verification.code, message: verification.message };
      continue;
    }
    if (verification.value.verdict === 'needs_detail') {
      final = {
        status: 'needs_detail',
        result: { ...rw, status: 'needs_detail', rewrite_text: null, preserved_facts: [], question_for_user: verification.value.issues[0]?.explanation ?? fallbackQuestion },
        text: null,
        question: verification.value.issues[0]?.explanation ?? fallbackQuestion,
        factCheck: 'failed',
        verification: verification.value,
        signals,
        candidateEvaluationId: null,
        candidate: null,
        label: null,
        error: null,
      };
      break;
    }
    if (verification.value.verdict === 'revise') {
      lastFailure = { code: 'verifier_revise', message: verification.value.issues.map((i) => `"${i.rewrite_span}": ${i.explanation}`).join('; ') || 'unsupported content' };
      continue;
    }
    // Independent re-evaluation of the candidate with the same rubric and evidence rules.
    let candidateRow: Final['candidate'] = null;
    let label: 'stronger_version' | 'another_way' | null = 'another_way';
    try {
      const candidate = await evaluateSubject(ctx, {
        framework: fw,
        prompt: { id: promptEntry.seed.id, text: promptEntry.seed.prompt, kind: promptEntry.seed.kind, criterion_ids: promptEntry.seed.criterion_ids },
        confirmedText: rw.rewrite_text,
        transcriptRevision: rewrite.transcript_revision,
        inputMode: attempt.input_mode,
        isGuidedRetry: false,
        partnerTurns: null,
      });
      const verdict = rewriteImprovementVerdict({
        original: { criteria: evaluation.result.criteria, boundary_gate: evaluation.result.boundary_gate, status: evaluation.result.status },
        rewrite: { criteria: candidate.evaluation.criteria, boundary_gate: candidate.evaluation.boundary_gate, status: candidate.evaluation.status },
        framework: fw.config,
        targetCriterionIds: targetIds,
      });
      if (verdict.label === 'not_improved') {
        lastFailure = { code: 'not_improved', message: `Candidate lowered a source-rule criterion or raised a boundary issue (${verdict.reasons.join(', ')}).` };
        continue;
      }
      label = verdict.label;
      candidateRow = {
        evaluation: candidate.evaluation,
        totals: candidate.totals,
        status: candidate.evaluation.status,
        model: candidate.meta.model,
        template: candidate.meta.prompt_template_version,
        latency: candidate.meta.latency_ms,
        ordinal: generationAttempts,
      };
    } catch (err) {
      if (err instanceof InvalidModelOutputError) {
        label = 'another_way'; // cannot prove improvement without a valid candidate evaluation
      } else {
        throw err;
      }
    }
    final = {
      status: 'ready',
      result: rw,
      text: rw.rewrite_text,
      question: null,
      factCheck: 'passed',
      verification: verification.value,
      signals,
      candidateEvaluationId: null,
      candidate: candidateRow,
      label,
      error: null,
    };
  }

  if (final === null) {
    // Regeneration exhausted: ask for a concrete detail rather than synthesizing rejected text.
    final = {
      status: 'needs_detail',
      result: null,
      text: null,
      question: fallbackQuestion,
      factCheck: 'failed',
      verification: null,
      signals: null,
      candidateEvaluationId: null,
      candidate: null,
      label: null,
      error: lastFailure,
    };
  }
  const done = final;
  return commitStage(ctx, job, { attemptId: attempt.id, revision: rewrite.transcript_revision }, async (tx) => {
    let candidateEvaluationId: string | null = done.candidateEvaluationId;
    if (done.candidate) {
      // Written inside the commit guard so a deleted attempt or superseded revision never gains a candidate row.
      const inserted = await tx<{ id: string }[]>`
        insert into public.evaluations (user_id, attempt_id, transcript_revision, kind, candidate_ordinal, config_version, model_id, prompt_template_version,
          rubric_version, framework_id, result, totals, status, source_copy_flag, is_guided_retry, provider_meta)
        values (${attempt.user_id}, ${attempt.id}, ${rewrite.transcript_revision}, 'rewrite_candidate', ${done.candidate.ordinal}, ${rewrite.config_version}, ${done.candidate.model},
          ${done.candidate.template}, ${fw.config.rubric_version}, ${fw.config.id}, ${tx.json(done.candidate.evaluation as never)}, ${tx.json(done.candidate.totals as never)},
          ${done.candidate.status}, null, false, ${tx.json({ latency_ms: done.candidate.latency } as never)})
        on conflict (attempt_id, transcript_revision, config_version, kind, candidate_ordinal) do update set id = public.evaluations.id
        returning id`;
      candidateEvaluationId = inserted[0]!.id;
    }
    await tx`
      update public.rewrites set status = ${done.status}, result = ${done.result ? tx.json(done.result as never) : null}, rewrite_text = ${done.text},
        question_for_user = ${done.question}, fact_check_state = ${done.factCheck}, verification = ${done.verification ? tx.json(done.verification as never) : null},
        fact_signals = ${done.signals ? tx.json(done.signals as never) : null}, candidate_evaluation_id = ${candidateEvaluationId}, improvement_label = ${done.label},
        generation_attempts = ${generationAttempts}, error = ${done.error ? tx.json(done.error as never) : null}, updated_at = now()
      where id = ${rewrite.id}`;
    if (done.status === 'ready') {
      await recordServerEvent(tx as unknown as Db, attempt.user_id, 'rewrite_ready', `rewrite:${rewrite.id}`, { framework_id: fw.config.id, label: done.label ?? 'none' });
    }
    return { resultId: rewrite.id, resultKind: 'rewrite', checkpoint: { generation_attempts: generationAttempts, status: done.status } };
  });
}

// ---------------------------------------------------------------------------
// speech (TTS of the stored validated rewrite text only)
// ---------------------------------------------------------------------------
export async function handleSpeech(ctx: ServerContext, job: JobRow): Promise<StageOutcome> {
  const rewriteId = String(job.payload['rewrite_id']);
  const voice = String(job.payload['voice'] ?? ctx.config.TTS_VOICE);
  const rewrite = (await ctx.sql<RewriteRow[]>`select * from public.rewrites where id = ${rewriteId}`)[0];
  if (!rewrite || rewrite.status !== 'ready' || !rewrite.rewrite_text) throw new StaleJobError('rewrite not ready for speech');
  const attempt = await loadAttempt(ctx.sql, rewrite.attempt_id);
  if (attempt.current_revision !== rewrite.transcript_revision) throw new StaleJobError('revision superseded before speech');
  const text = rewrite.rewrite_text;
  const textHash = createHash('sha256').update(text).digest('hex');

  const existingReady = (await ctx.sql<AudioAssetRow[]>`
    select * from public.audio_assets where rewrite_id = ${rewrite.id} and kind = 'tts' and state = 'ready' and deleted_at is null
       and text_sha256 = ${textHash} and voice_id = ${voice} and (expires_at is null or expires_at > now()) order by created_at desc limit 1`)[0];
  if (existingReady) return commitStage(ctx, job, { attemptId: attempt.id, revision: rewrite.transcript_revision }, async () => ({ resultId: existingReady.id, resultKind: 'asset' }));

  // Resume after a crash between upload and commit without paying the provider twice.
  let assetId = typeof job.checkpoint['asset_id'] === 'string' ? (job.checkpoint['asset_id'] as string) : null;
  let objectKey = typeof job.checkpoint['object_key'] === 'string' ? (job.checkpoint['object_key'] as string) : null;
  let mime = typeof job.checkpoint['mime'] === 'string' ? (job.checkpoint['mime'] as string) : 'audio/mpeg';
  let bytesLen = Number(job.checkpoint['bytes'] ?? 0);
  let duration = typeof job.checkpoint['duration'] === 'number' ? (job.checkpoint['duration'] as number) : null;
  let model = typeof job.checkpoint['model'] === 'string' ? (job.checkpoint['model'] as string) : ctx.providers.speech.model;
  if (!(assetId && objectKey && (await ctx.storage.head(objectKey)))) {
    const speech = await ctx.providers.speech.synthesize({ text, voice }, { timeoutMs: ctx.config.TIMEOUT_TTS_MS });
    assetId = crypto.randomUUID();
    objectKey = ttsAudioKey(attempt.user_id, attempt.id, rewrite.id, assetId);
    await ctx.storage.upload(objectKey, speech.bytes, speech.mime);
    mime = speech.mime;
    bytesLen = speech.bytes.length;
    model = speech.model;
    try {
      duration = probeAudio(speech.bytes).duration_seconds;
    } catch {
      duration = null;
    }
    await saveCheckpoint(ctx.sql, job, { asset_id: assetId, object_key: objectKey, mime, bytes: bytesLen, duration, model });
  }
  const expiresAt = new Date(ctx.now().getTime() + ctx.config.TTS_TTL_HOURS * 3_600_000);
  return commitStage(ctx, job, { attemptId: attempt.id, revision: rewrite.transcript_revision }, async (tx) => {
    await tx`
      insert into public.audio_assets (id, user_id, attempt_id, kind, bucket, object_key, state, verified_mime, verified_bytes, verified_duration_seconds,
        rewrite_id, voice_id, tts_model, text_sha256, expires_at)
      values (${assetId}, ${attempt.user_id}, ${attempt.id}, 'tts', ${ctx.config.STORAGE_BUCKET_AUDIO}, ${objectKey}, 'ready', ${mime}, ${bytesLen},
        ${duration === null ? null : duration.toFixed(3)}, ${rewrite.id}, ${voice}, ${model}, ${textHash}, ${expiresAt})
      on conflict (id) do nothing`;
    return { resultId: assetId, resultKind: 'asset', checkpoint: { asset_id: assetId } };
  });
}

// ---------------------------------------------------------------------------
// roleplay turn and session evaluation
// ---------------------------------------------------------------------------
export async function handleRoleplayTurn(ctx: ServerContext, job: JobRow): Promise<StageOutcome> {
  const session = await loadSession(ctx.sql, job.session_id!);
  const state = session.roleplay_state;
  if (!state) throw new StaleJobError('not a roleplay session');
  const exchangeNo = Number(job.payload['exchange']);
  const entry = state.exchanges.find((e) => e.exchange === exchangeNo);
  if (!entry) throw new StaleJobError('exchange missing from state');
  if (entry.partner_reply) return commitStage(ctx, job, { attemptId: entry.attempt_id, revision: entry.transcript_revision }, async () => ({ resultId: entry.attempt_id, resultKind: 'roleplay_turn' }));
  const attempt = await loadAttempt(ctx.sql, entry.attempt_id);
  if (attempt.current_revision !== entry.transcript_revision) throw new StaleJobError('turn revision superseded');
  const prior = state.exchanges.filter((e) => e.exchange < exchangeNo).map((e) => ({ exchange: e.exchange, learner: e.learner_text, partner: e.partner_reply }));
  const turnsRemaining = 3 - exchangeNo + 1;
  const raw = await ctx.providers.partner.reply(
    { scenario: state.scenario, partner_facts: `${state.partner_name}: ${state.partner_facts}`, prior_turns: prior, learner_turn: entry.learner_text, turns_remaining: turnsRemaining },
    { timeoutMs: ctx.config.TIMEOUT_EVALUATE_MS },
  );
  const validated = validatePartnerReply(raw.raw, { exchangeNumber: exchangeNo });
  if (!validated.ok) throw new InvalidModelOutputError('roleplay', validated.code, validated.message);
  const reply = validated.value;
  return commitStage(ctx, job, { attemptId: attempt.id, revision: entry.transcript_revision }, async (tx) => {
    const current = (await tx<{ roleplay_state: RoleplayState }[]>`select roleplay_state from public.practice_sessions where id = ${session.id} for update`)[0]!.roleplay_state;
    const next: RoleplayState = {
      ...current,
      exchanges: current.exchanges.map((e) =>
        e.exchange === exchangeNo ? { ...e, partner_reply: reply.partner_reply, conversation_state: reply.conversation_state, boundary_signal: reply.boundary_signal } : e,
      ),
      ended: current.ended || reply.conversation_state === 'ended',
    };
    await tx`update public.practice_sessions set roleplay_state = ${tx.json(next as never)}, updated_at = now() where id = ${session.id}`;
    return { resultId: attempt.id, resultKind: 'roleplay_turn' };
  });
}

export async function handleRoleplayEvaluate(ctx: ServerContext, job: JobRow): Promise<StageOutcome> {
  const session = await loadSession(ctx.sql, job.session_id!);
  const state = session.roleplay_state;
  if (!state) throw new StaleJobError('not a roleplay session');
  if (state.session_evaluation_id) {
    return commitStage(ctx, job, {}, async () => ({ resultId: state.session_evaluation_id, resultKind: 'evaluation' }));
  }
  const completed = state.exchanges.filter((e) => e.partner_reply !== null && !e.deleted && e.learner_text.length > 0);
  const last = completed.at(-1);
  if (!last) throw new StaleJobError('no completed exchange');
  const attempt = await loadAttempt(ctx.sql, last.attempt_id);
  const fw = frameworkOrThrow(ctx, session.framework_id);
  const promptEntry = ctx.catalog.promptsById.get(session.prompt_id);
  if (!promptEntry) throw new InvalidModelOutputError('content', 'prompt_missing', 'Prompt is not in the catalog.');
  const learnerText = completed.map((e) => e.learner_text).join('\n');
  const evaluated = await evaluateSubject(
    ctx,
    {
      framework: fw,
      prompt: { id: promptEntry.seed.id, text: promptEntry.seed.prompt, kind: promptEntry.seed.kind, criterion_ids: promptEntry.seed.criterion_ids },
      confirmedText: learnerText,
      transcriptRevision: last.transcript_revision,
      inputMode: attempt.input_mode,
      isGuidedRetry: false,
      partnerTurns: completed.map((e) => ({ exchange: e.exchange, learner: e.learner_text, partner: e.partner_reply })),
    },
    { cachedRaw: job.checkpoint['raw_evaluation'] },
  );
  await saveCheckpoint(ctx.sql, job, { raw_evaluation: evaluated.evaluation });
  const profile = (await ctx.sql<{ timezone: string }[]>`select timezone from public.profiles where id = ${attempt.user_id}`)[0];
  const cfg = `${ctx.config.PROMPT_CONFIG_VERSION}|rubric:${fw.config.rubric_version}|eval:${ctx.config.EVALUATION_MODEL}|roleplay`;
  return commitStage(ctx, job, { attemptId: attempt.id, revision: last.transcript_revision }, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      insert into public.evaluations (user_id, attempt_id, transcript_revision, kind, candidate_ordinal, config_version, model_id, prompt_template_version,
        rubric_version, framework_id, result, totals, status, source_copy_flag, is_guided_retry, provider_meta)
      values (${attempt.user_id}, ${attempt.id}, ${last.transcript_revision}, 'roleplay_session', 0, ${cfg}, ${evaluated.meta.model}, ${evaluated.meta.prompt_template_version},
        ${fw.config.rubric_version}, ${fw.config.id}, ${tx.json(evaluated.evaluation as never)}, ${tx.json(evaluated.totals as never)}, ${evaluated.evaluation.status},
        ${evaluated.sourceCopy ? tx.json(evaluated.sourceCopy as never) : null}, false, ${tx.json({ latency_ms: evaluated.meta.latency_ms, exchanges: completed.length } as never)})
      on conflict (attempt_id, transcript_revision, config_version, kind, candidate_ordinal) do update set id = public.evaluations.id
      returning id`;
    const evaluationId = rows[0]!.id;
    const current = (await tx<{ roleplay_state: RoleplayState }[]>`select roleplay_state from public.practice_sessions where id = ${session.id} for update`)[0]!.roleplay_state;
    await tx`update public.practice_sessions set roleplay_state = ${tx.json({ ...current, ended: true, session_evaluation_id: evaluationId } as never)}, updated_at = now() where id = ${session.id}`;
    await tx`update public.attempts set stage = 'feedback', updated_at = now() where id = ${attempt.id}`;
    await recordEvidence(tx as unknown as Db, {
      userId: attempt.user_id,
      frameworkId: fw.config.id,
      rubricVersion: fw.config.rubric_version,
      attemptId: attempt.id,
      evaluationId,
      promptId: session.prompt_id,
      sessionId: session.id,
      lessonId: null,
      lessonVersion: null,
      guided: false,
      masteryQualifies: evaluated.totals.mastery_qualifies,
      status: evaluated.evaluation.status,
      confidence: evaluated.evaluation.confidence,
      sourceCopy: evaluated.sourceCopy !== null,
      displayedTotal: evaluated.totals.displayed_total,
      timezone: profile?.timezone ?? 'UTC',
      occurredAt: ctx.now(),
    });
    await commitSession(tx as unknown as Db, session.id);
    await markSessionCompleted(tx as unknown as Db, session.id);
    return { resultId: evaluationId, resultKind: 'evaluation' };
  });
}

// ---------------------------------------------------------------------------
// deletion and reconciliation
// ---------------------------------------------------------------------------
export async function handleDeleteAttempt(ctx: ServerContext, job: JobRow): Promise<StageOutcome> {
  const attemptId = job.attempt_id!;
  const assets = await ctx.sql<{ id: string; object_key: string }[]>`select id, object_key from public.audio_assets where attempt_id = ${attemptId} and storage_deleted_at is null`;
  await ctx.storage.remove(assets.map((a) => a.object_key));
  await ctx.sql.begin(async (tx) => {
    await tx`update public.audio_assets set storage_deleted_at = now(), state = 'deleted', deleted_at = coalesce(deleted_at, now()), updated_at = now() where attempt_id = ${attemptId}`;
    // Private text also lives in job checkpoints/payloads and roleplay state; scrub both.
    await tx`update public.jobs set checkpoint = '{}'::jsonb, payload = '{}'::jsonb, error_message = null, updated_at = now() where attempt_id = ${attemptId} and id <> ${job.id}`;
    await tx`
      update public.practice_sessions s set roleplay_state = jsonb_set(s.roleplay_state, '{exchanges}', (
          select coalesce(jsonb_agg(case when e->>'attempt_id' = ${attemptId} then e || '{"learner_text":"","deleted":true}'::jsonb else e end order by (e->>'exchange')::int), '[]'::jsonb)
            from jsonb_array_elements(s.roleplay_state->'exchanges') e)), updated_at = now()
       where s.id = (select session_id from public.attempts where id = ${attemptId}) and s.roleplay_state is not null`;
    await tx`delete from public.reports where evaluation_id in (select id from public.evaluations where attempt_id = ${attemptId})`;
    await tx`update public.rewrites set candidate_evaluation_id = null where attempt_id = ${attemptId}`;
    await tx`delete from public.audio_assets where attempt_id = ${attemptId}`;
    await tx`delete from public.rewrites where attempt_id = ${attemptId}`;
    await tx`delete from public.skill_evidence where attempt_id = ${attemptId}`;
    await tx`delete from public.evaluations where attempt_id = ${attemptId}`;
    await tx`delete from public.transcript_revisions where attempt_id = ${attemptId}`;
    await tx`update public.deletion_jobs set state = 'completed', completed_at = now() where attempt_id = ${attemptId} and scope = 'attempt' and state <> 'completed'`;
    await tx`update public.jobs set state = 'succeeded', finished_at = now(), updated_at = now(), lease_until = null, result_id = ${attemptId}, result_kind = null where id = ${job.id} and worker_id = ${ctx.config.workerId}`;
  });
  return { resultId: attemptId, resultKind: null };
}

export async function handleDeleteAccount(ctx: ServerContext, job: JobRow): Promise<StageOutcome> {
  const userId = job.user_id;
  const deletionJobId = typeof job.payload['deletion_job_id'] === 'string' ? (job.payload['deletion_job_id'] as string) : null;
  const step = async (name: string, fn: () => Promise<void>) => {
    await fn();
    if (deletionJobId) await ctx.sql`update public.deletion_jobs set steps = steps || ${ctx.sql.json([{ step: name, at: new Date().toISOString() }] as never)}, state = 'running' where id = ${deletionJobId}`;
  };
  await step('storage_objects', async () => {
    const assets = await ctx.sql<{ object_key: string }[]>`select object_key from public.audio_assets where user_id = ${userId} and storage_deleted_at is null`;
    await ctx.storage.remove(assets.map((a) => a.object_key));
    await ctx.sql`update public.audio_assets set storage_deleted_at = now(), state = 'deleted', updated_at = now() where user_id = ${userId}`;
  });
  await step('rows', async () => {
    await ctx.sql.begin(async (tx) => {
      await tx`delete from public.reports where user_id = ${userId}`;
      await tx`delete from public.audio_assets where user_id = ${userId}`;
      await tx`delete from public.rewrites where user_id = ${userId}`;
      await tx`delete from public.skill_evidence where user_id = ${userId}`;
      await tx`delete from public.evaluations where user_id = ${userId}`;
      await tx`delete from public.transcript_revisions where user_id = ${userId}`;
      await tx`delete from public.completions where user_id = ${userId}`;
      await tx`delete from public.practice_days where user_id = ${userId}`;
      await tx`delete from public.skill_progress where user_id = ${userId}`;
      await tx`delete from public.attempts where user_id = ${userId}`;
      await tx`delete from public.reservations where user_id = ${userId}`;
      await tx`delete from public.practice_sessions where user_id = ${userId}`;
      await tx`delete from public.daily_assignments where user_id = ${userId}`;
      await tx`delete from public.quota_windows where user_id = ${userId}`;
      await tx`delete from public.telemetry_events where user_id = ${userId}`;
      // Entitlement rows are minimized, not deleted: store subscription management stays with the store.
      await tx`update public.entitlements set provider_customer_id = null, updated_at = now() where user_id = ${userId}`;
      await tx`delete from public.jobs where user_id = ${userId} and id <> ${job.id}`;
    });
  });
  await step('provider_identity', async () => {
    // Billing customer identity is the app user id; RevenueCat customer deletion is an owner dashboard/API action recorded here.
  });
  await step('auth_identity', async () => {
    await ctx.sql`update public.profiles set account_state = 'deleted', goal = null, experience = null, social_context = null, locale = null, reminder_enabled = false, reminder_time = null, updated_at = now() where id = ${userId}`;
    await ctx.accounts.deleteAuthUser(userId);
  });
  if (deletionJobId) await ctx.sql`update public.deletion_jobs set state = 'completed', completed_at = now() where id = ${deletionJobId}`;
  await recordServerEvent(ctx.sql, null, 'deletion_completed', `deletion:${userId}:${job.generation}`, { scope: 'account' });
  await ctx.sql`update public.jobs set state = 'succeeded', finished_at = now(), updated_at = now(), lease_until = null where id = ${job.id} and worker_id = ${ctx.config.workerId}`;
  return { resultId: null, resultKind: null };
}

export async function handleReconcileEntitlement(ctx: ServerContext, job: JobRow): Promise<StageOutcome> {
  const snap = await ctx.providers.entitlements.fetch(job.user_id);
  await applyEntitlementSnapshot(ctx, job.user_id, snap);
  await ctx.sql`update public.jobs set state = 'succeeded', finished_at = now(), updated_at = now(), lease_until = null where id = ${job.id} and worker_id = ${ctx.config.workerId}`;
  return { resultId: null, resultKind: null };
}
