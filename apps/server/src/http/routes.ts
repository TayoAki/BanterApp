import type { Hono } from 'hono';
import { z } from 'zod';
import { todayResponse } from '../domain/assignments.js';
import { attemptDto, completeUpload, confirmTranscript, createAttempt, createUpload, getOwnedAttempt, requestEvaluation } from '../domain/attempts.js';
import { deleteAttempt, requestAccountDeletion } from '../domain/deletion.js';
import { entitlementDto, getEntitlementRow, getPlan, handleBillingEvent, restoreEntitlement } from '../domain/entitlements.js';
import { getOwnedJob, jobStatusDto } from '../domain/jobs.js';
import { getProfile, preferencesDto, preferencesPatchSchema, updatePreferences } from '../domain/profiles.js';
import { comparisonResponse, progressResponse } from '../domain/progress.js';
import { createReport, REPORT_REASONS } from '../domain/reports.js';
import { evaluationDto, getOwnedEvaluation, getOwnedRewrite, playback, requestRewrite, requestSpeech, rewriteDto } from '../domain/results.js';
import { finishRoleplay, requestRoleplayTurn, roleplayStateDto } from '../domain/roleplay.js';
import { createSession, ensureSessionReservation, getOwnedSession, sessionDto } from '../domain/sessions.js';
import { recordClientEvents, telemetrySchema } from '../domain/telemetry.js';
import { requireActor, type Env } from './app.js';
import { ApiError } from './errors.js';
import { clientKeySchema, confirmedTextSchema, parseBody, parseUuidParam, uuidSchema } from './validation.js';

export function registerRoutes(app: Hono<Env>): void {
  // -------------------------------------------------------------------------
  // Public content (published only; editors see drafts labeled)
  // -------------------------------------------------------------------------
  app.get('/v1/catalog', (c) => {
    const ctx = c.get('ctx');
    const viewer = { editor: c.get('actor')?.editor ?? false };
    const frameworks = ctx.catalog.visibleFrameworks(viewer).map((f) => ctx.catalog.outlineDto(f, viewer));
    const sample = ctx.catalog.guestSampleLesson();
    return c.json({ frameworks, guest_sample_lesson_id: sample?.seed.id ?? null, manifest: ctx.catalog.manifest.manifest, next_cursor: null });
  });

  app.get('/v1/lessons/:id', (c) => {
    const ctx = c.get('ctx');
    const viewer = { editor: c.get('actor')?.editor ?? false };
    const id = c.req.param('id');
    const entry = ctx.catalog.visibleLesson(id, viewer);
    if (!entry) throw ApiError.notFound('Lesson not found.');
    const version = c.req.query('version');
    if (version && Number(version) !== entry.seed.version) throw ApiError.notFound('Lesson version not found.');
    return c.json(ctx.catalog.lessonDto(entry, viewer));
  });

  // -------------------------------------------------------------------------
  // Today, sessions, attempts
  // -------------------------------------------------------------------------
  app.get('/v1/today', async (c) => c.json(await todayResponse(c.get('ctx'), requireActor(c))));

  const createSessionSchema = z.object({
    client_key: clientKeySchema,
    mode: z.enum(['daily', 'lesson', 'review', 'mixed', 'roleplay']),
    assignment_id: uuidSchema.optional(),
    prompt_id: z.string().min(1).max(32).optional(),
    prompt_version: z.number().int().positive().optional(),
  });
  app.post('/v1/sessions', async (c) => {
    const ctx = c.get('ctx');
    const actor = requireActor(c);
    const body = parseBody(createSessionSchema, await c.req.json());
    const { row, created } = await createSession(ctx, actor, body);
    return c.json(await sessionDto(ctx, actor, row, created), created ? 201 : 200);
  });

  app.get('/v1/sessions/:id', async (c) => {
    const ctx = c.get('ctx');
    const actor = requireActor(c);
    const row = await getOwnedSession(ctx, actor.userId, parseUuidParam(c.req.param('id'), 'Session'));
    return c.json(await sessionDto(ctx, actor, row, false));
  });

  const createAttemptSchema = z.object({
    client_key: clientKeySchema,
    ordinal: z.number().int().min(1).max(10),
    retry_of: uuidSchema.nullable().optional(),
    input_mode: z.enum(['voice', 'typed']),
  });
  app.post('/v1/sessions/:id/attempts', async (c) => {
    const ctx = c.get('ctx');
    const actor = requireActor(c);
    const body = parseBody(createAttemptSchema, await c.req.json());
    const { row, created } = await createAttempt(ctx, actor, parseUuidParam(c.req.param('id'), 'Session'), body);
    return c.json(await attemptDto(ctx, row), created ? 201 : 200);
  });

  app.get('/v1/attempts/:id', async (c) => {
    const ctx = c.get('ctx');
    const actor = requireActor(c);
    const row = await getOwnedAttempt(ctx, actor.userId, parseUuidParam(c.req.param('id'), 'Attempt'));
    return c.json(await attemptDto(ctx, row));
  });

  const uploadSchema = z.object({
    client_key: clientKeySchema,
    expected_bytes: z.number().int(),
    mime: z.string().min(3).max(64),
    duration_seconds_hint: z.number().nonnegative().optional(),
  });
  app.post('/v1/attempts/:id/upload', async (c) => {
    const ctx = c.get('ctx');
    const actor = requireActor(c);
    const body = parseBody(uploadSchema, await c.req.json());
    return c.json(await createUpload(ctx, actor, parseUuidParam(c.req.param('id'), 'Attempt'), body), 201);
  });

  const uploadCompleteSchema = z.object({ client_key: clientKeySchema, asset_id: uuidSchema });
  app.post('/v1/attempts/:id/upload-complete', async (c) => {
    const ctx = c.get('ctx');
    const actor = requireActor(c);
    const body = parseBody(uploadCompleteSchema, await c.req.json());
    const attemptId = parseUuidParam(c.req.param('id'), 'Attempt');
    const attempt = await getOwnedAttempt(ctx, actor.userId, attemptId);
    await ensureSessionReservation(ctx, actor, await getOwnedSession(ctx, actor.userId, attempt.session_id));
    const { job } = await completeUpload(ctx, actor, attemptId, body.asset_id);
    return c.json({ job: jobStatusDto(job), attempt: await attemptDto(ctx, await getOwnedAttempt(ctx, actor.userId, attemptId)) }, 202);
  });

  const confirmSchema = z.object({ client_key: clientKeySchema, expected_revision: z.number().int().min(0).max(10), confirmed_text: confirmedTextSchema });
  app.put('/v1/attempts/:id/transcript', async (c) => {
    const ctx = c.get('ctx');
    const actor = requireActor(c);
    const body = parseBody(confirmSchema, await c.req.json());
    const { attempt } = await confirmTranscript(ctx, actor, parseUuidParam(c.req.param('id'), 'Attempt'), body);
    return c.json(await attemptDto(ctx, attempt));
  });

  const evaluateSchema = z.object({ client_key: clientKeySchema, revision: z.number().int().min(1).max(10) });
  app.post('/v1/attempts/:id/evaluate', async (c) => {
    const ctx = c.get('ctx');
    const actor = requireActor(c);
    const body = parseBody(evaluateSchema, await c.req.json());
    const attemptId = parseUuidParam(c.req.param('id'), 'Attempt');
    const attempt = await getOwnedAttempt(ctx, actor.userId, attemptId);
    await ensureSessionReservation(ctx, actor, await getOwnedSession(ctx, actor.userId, attempt.session_id));
    const { job, existingEvaluationId } = await requestEvaluation(ctx, actor, attemptId, body.revision);
    return c.json({ job: jobStatusDto(job), evaluation_id: existingEvaluationId }, 202);
  });

  app.delete('/v1/attempts/:id', async (c) => {
    const ctx = c.get('ctx');
    const actor = requireActor(c);
    const { job } = await deleteAttempt(ctx, actor, parseUuidParam(c.req.param('id'), 'Attempt'));
    return c.json({ job: jobStatusDto(job) }, 202);
  });

  // -------------------------------------------------------------------------
  // Feedback, rewrite, speech, playback, jobs
  // -------------------------------------------------------------------------
  app.get('/v1/evaluations/:id', async (c) => {
    const ctx = c.get('ctx');
    const actor = requireActor(c);
    return c.json(await evaluationDto(ctx, await getOwnedEvaluation(ctx, actor.userId, parseUuidParam(c.req.param('id'), 'Feedback'))));
  });

  const clientKeyOnly = z.object({ client_key: clientKeySchema });
  app.post('/v1/evaluations/:id/rewrite', async (c) => {
    const ctx = c.get('ctx');
    const actor = requireActor(c);
    parseBody(clientKeyOnly, await c.req.json());
    const { rewrite, job } = await requestRewrite(ctx, actor, parseUuidParam(c.req.param('id'), 'Feedback'));
    return c.json({ rewrite: await rewriteDto(ctx, rewrite), job: job ? jobStatusDto(job) : null }, 202);
  });

  app.get('/v1/rewrites/:id', async (c) => {
    const ctx = c.get('ctx');
    const actor = requireActor(c);
    return c.json(await rewriteDto(ctx, await getOwnedRewrite(ctx, actor.userId, parseUuidParam(c.req.param('id'), 'Rewrite'))));
  });

  const speechSchema = z.object({ client_key: clientKeySchema, voice: z.string().min(2).max(24).optional() });
  app.post('/v1/rewrites/:id/speech', async (c) => {
    const ctx = c.get('ctx');
    const actor = requireActor(c);
    const body = parseBody(speechSchema, await c.req.json());
    const { asset, job } = await requestSpeech(ctx, actor, parseUuidParam(c.req.param('id'), 'Rewrite'), body.voice);
    if (asset) return c.json({ asset_id: asset.id, job: null, state: 'ready' }, 200);
    return c.json({ asset_id: null, job: job ? jobStatusDto(job) : null, state: 'queued' }, 202);
  });

  app.get('/v1/assets/:id/playback', async (c) => {
    const ctx = c.get('ctx');
    const actor = requireActor(c);
    return c.json(await playback(ctx, actor, parseUuidParam(c.req.param('id'), 'Audio')));
  });

  app.get('/v1/jobs/:id', async (c) => {
    const ctx = c.get('ctx');
    const actor = requireActor(c);
    return c.json(jobStatusDto(await getOwnedJob(ctx, actor.userId, parseUuidParam(c.req.param('id'), 'Job'))));
  });

  // -------------------------------------------------------------------------
  // Roleplay
  // -------------------------------------------------------------------------
  const roleplayTurnSchema = z.object({
    client_key: clientKeySchema,
    attempt_id: uuidSchema,
    transcript_revision: z.number().int().min(1).max(10),
    expected_exchange: z.number().int().min(1).max(3),
  });
  app.post('/v1/sessions/:id/roleplay-turn', async (c) => {
    const ctx = c.get('ctx');
    const actor = requireActor(c);
    const body = parseBody(roleplayTurnSchema, await c.req.json());
    const sessionId = parseUuidParam(c.req.param('id'), 'Session');
    const { job } = await requestRoleplayTurn(ctx, actor, sessionId, body);
    return c.json({ job: jobStatusDto(job), roleplay: roleplayStateDto(await getOwnedSession(ctx, actor.userId, sessionId)) }, 202);
  });
  app.get('/v1/sessions/:id/roleplay', async (c) => {
    const ctx = c.get('ctx');
    const actor = requireActor(c);
    return c.json(roleplayStateDto(await getOwnedSession(ctx, actor.userId, parseUuidParam(c.req.param('id'), 'Session'))));
  });
  app.post('/v1/sessions/:id/roleplay-finish', async (c) => {
    const ctx = c.get('ctx');
    const actor = requireActor(c);
    parseBody(clientKeyOnly, await c.req.json());
    const sessionId = parseUuidParam(c.req.param('id'), 'Session');
    const { job } = await finishRoleplay(ctx, actor, sessionId);
    return c.json({ job: job ? jobStatusDto(job) : null, roleplay: roleplayStateDto(await getOwnedSession(ctx, actor.userId, sessionId)) }, 202);
  });

  // -------------------------------------------------------------------------
  // Progress, preferences, entitlements, reports, deletion, telemetry
  // -------------------------------------------------------------------------
  app.get('/v1/progress', async (c) => c.json(await progressResponse(c.get('ctx'), requireActor(c), c.req.query('cursor') ?? null)));
  app.get('/v1/sessions/:id/comparison', async (c) => c.json(await comparisonResponse(c.get('ctx'), requireActor(c), parseUuidParam(c.req.param('id'), 'Session'))));

  app.get('/v1/preferences', async (c) => c.json(preferencesDto(await getProfile(c.get('ctx'), requireActor(c).userId))));
  app.patch('/v1/preferences', async (c) => {
    const body = parseBody(preferencesPatchSchema, await c.req.json());
    return c.json(await updatePreferences(c.get('ctx'), requireActor(c), body));
  });

  app.get('/v1/entitlements', async (c) => {
    const ctx = c.get('ctx');
    const actor = requireActor(c);
    return c.json(entitlementDto(await getEntitlementRow(ctx, actor.userId), await getPlan(ctx, actor.userId)));
  });
  app.post('/v1/entitlements/restore', async (c) => {
    parseBody(clientKeyOnly, await c.req.json());
    return c.json(await restoreEntitlement(c.get('ctx'), requireActor(c).userId));
  });

  const reportSchema = z.object({ evaluation_id: uuidSchema, reason: z.enum(REPORT_REASONS), share_evidence: z.boolean(), note: z.string().max(500).optional() });
  app.post('/v1/reports', async (c) => {
    const body = parseBody(reportSchema, await c.req.json());
    return c.json(await createReport(c.get('ctx'), requireActor(c), body), 201);
  });

  app.post('/v1/account/deletion', async (c) => {
    parseBody(clientKeyOnly, await c.req.json());
    const result = await requestAccountDeletion(c.get('ctx'), requireActor(c));
    return c.json({ deletion_job_id: result.deletion_job_id, job: jobStatusDto(result.job) }, 202);
  });

  app.post('/v1/telemetry', async (c) => {
    const body = parseBody(telemetrySchema, await c.req.json());
    return c.json(await recordClientEvents(c.get('ctx'), requireActor(c), body));
  });

  // Provider-authenticated (no bearer session): billing webhook.
  app.post('/v1/billing/events', async (c) => {
    const ctx = c.get('ctx');
    const raw = await c.req.text();
    const headers: Record<string, string | undefined> = { authorization: c.req.header('authorization') };
    const result = await handleBillingEvent(ctx, { headers, rawBody: raw });
    if (!result.accepted) return c.json({ ok: false, reason: result.reason }, result.reason === 'authentication_failed' ? 401 : 400);
    return c.json({ ok: true, state: result.state }, 200);
  });
}
