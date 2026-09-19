import type {
  AllowanceDto,
  ApiError,
  AttemptDto,
  ComparisonResponse,
  ConfirmTranscriptRequest,
  CreateAttemptRequest,
  CreateSessionRequest,
  EntitlementDto,
  EvaluationDto,
  FrameworkOutlineDto,
  JobStatusDto,
  LessonDto,
  PlaybackResponse,
  PreferencesDto,
  ProgressResponse,
  RewriteDto,
  RoleplayStateDto,
  RoleplayTurnRequest,
  SessionDto,
  TodayResponse,
  UploadRequest,
  UploadResponse,
} from '@marshmemos/contracts/api';
import { env } from './env';

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly requestId: string | null,
    readonly details: Record<string, unknown> | undefined,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
  static offline(): ApiClientError {
    return new ApiClientError(0, 'offline', 'You’re offline. Your progress on this device is safe.', true, null, undefined);
  }
}

export type TokenProvider = () => Promise<string | null>;

let tokenProvider: TokenProvider = async () => null;
export function setTokenProvider(provider: TokenProvider): void {
  tokenProvider = provider;
}

async function request<T>(method: string, path: string, body?: unknown, opts: { auth?: boolean; timeoutMs?: number } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (opts.auth !== false) {
    const token = await tokenProvider();
    if (token) headers['authorization'] = `Bearer ${token}`;
  }
  if (body !== undefined) headers['content-type'] = 'application/json';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  let res: Response;
  try {
    res = await fetch(`${env.apiBaseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === 'AbortError') throw new ApiClientError(0, 'timeout', 'The request timed out.', true, null, undefined);
    throw ApiClientError.offline();
  }
  clearTimeout(timer);
  const text = await res.text();
  const json = text ? safeJson(text) : null;
  if (!res.ok) {
    const e = (json ?? {}) as Partial<ApiError> & { details?: Record<string, unknown> };
    throw new ApiClientError(res.status, e.code ?? `http_${res.status}`, e.message ?? 'Something went wrong.', e.retryable ?? res.status >= 500, e.request_id ?? null, e.details);
  }
  return json as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface CatalogResponse {
  frameworks: FrameworkOutlineDto[];
  guest_sample_lesson_id: string | null;
  manifest: string;
}

export const api = {
  catalog: () => request<CatalogResponse>('GET', '/v1/catalog', undefined, { auth: true }),
  lesson: (id: string) => request<LessonDto>('GET', `/v1/lessons/${encodeURIComponent(id)}`, undefined, { auth: true }),
  today: () => request<TodayResponse>('GET', '/v1/today'),
  createSession: (body: CreateSessionRequest) => request<SessionDto>('POST', '/v1/sessions', body),
  session: (id: string) => request<SessionDto>('GET', `/v1/sessions/${id}`),
  createAttempt: (sessionId: string, body: CreateAttemptRequest) => request<AttemptDto>('POST', `/v1/sessions/${sessionId}/attempts`, body),
  attempt: (id: string) => request<AttemptDto>('GET', `/v1/attempts/${id}`),
  createUpload: (attemptId: string, body: UploadRequest) => request<UploadResponse>('POST', `/v1/attempts/${attemptId}/upload`, body),
  uploadComplete: (attemptId: string, body: { client_key: string; asset_id: string }) =>
    request<{ job: JobStatusDto; attempt: AttemptDto }>('POST', `/v1/attempts/${attemptId}/upload-complete`, body, { timeoutMs: 45_000 }),
  confirmTranscript: (attemptId: string, body: ConfirmTranscriptRequest) => request<AttemptDto>('PUT', `/v1/attempts/${attemptId}/transcript`, body),
  evaluate: (attemptId: string, body: { client_key: string; revision: number }) => request<{ job: JobStatusDto; evaluation_id: string | null }>('POST', `/v1/attempts/${attemptId}/evaluate`, body),
  deleteAttempt: (attemptId: string) => request<{ job: JobStatusDto }>('DELETE', `/v1/attempts/${attemptId}`),
  evaluation: (id: string) => request<EvaluationDto>('GET', `/v1/evaluations/${id}`),
  requestRewrite: (evaluationId: string, body: { client_key: string }) => request<{ rewrite: RewriteDto; job: JobStatusDto | null }>('POST', `/v1/evaluations/${evaluationId}/rewrite`, body),
  rewrite: (id: string) => request<RewriteDto>('GET', `/v1/rewrites/${id}`),
  requestSpeech: (rewriteId: string, body: { client_key: string; voice?: string }) =>
    request<{ asset_id: string | null; job: JobStatusDto | null; state: 'ready' | 'queued' }>('POST', `/v1/rewrites/${rewriteId}/speech`, body),
  playback: (assetId: string) => request<PlaybackResponse>('GET', `/v1/assets/${assetId}/playback`),
  job: (id: string) => request<JobStatusDto>('GET', `/v1/jobs/${id}`),
  roleplayTurn: (sessionId: string, body: RoleplayTurnRequest) => request<{ job: JobStatusDto; roleplay: RoleplayStateDto }>('POST', `/v1/sessions/${sessionId}/roleplay-turn`, body),
  roleplay: (sessionId: string) => request<RoleplayStateDto>('GET', `/v1/sessions/${sessionId}/roleplay`),
  roleplayFinish: (sessionId: string, body: { client_key: string }) => request<{ job: JobStatusDto | null; roleplay: RoleplayStateDto }>('POST', `/v1/sessions/${sessionId}/roleplay-finish`, body),
  progress: (cursor?: string | null) => request<ProgressResponse>('GET', `/v1/progress${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
  comparison: (sessionId: string) => request<ComparisonResponse>('GET', `/v1/sessions/${sessionId}/comparison`),
  preferences: () => request<PreferencesDto>('GET', '/v1/preferences'),
  updatePreferences: (patch: Record<string, unknown>) => request<PreferencesDto>('PATCH', '/v1/preferences', patch),
  entitlements: () => request<EntitlementDto>('GET', '/v1/entitlements'),
  restoreEntitlements: (body: { client_key: string }) => request<EntitlementDto>('POST', '/v1/entitlements/restore', body),
  report: (body: { evaluation_id: string; reason: string; share_evidence: boolean; note?: string }) =>
    request<{ report_id: string; received_at: string; evidence_shared: boolean }>('POST', '/v1/reports', body),
  requestAccountDeletion: (body: { client_key: string }) => request<{ deletion_job_id: string; job: JobStatusDto }>('POST', '/v1/account/deletion', body),
  telemetry: (events: Array<{ event_id: string; name: string; properties?: Record<string, string | number | boolean>; platform?: 'ios' | 'android' }>) =>
    request<{ accepted: number; rejected: number }>('POST', '/v1/telemetry', { events }),
};

export type { AllowanceDto };
