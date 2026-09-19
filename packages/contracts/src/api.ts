/**
 * HTTP API contract shared by the server and the mobile client (`/v1`).
 * Identity is always derived server-side; none of these DTOs carry an owner
 * ID supplied by the client.
 */
import type { BoundaryGate, Confidence, CriterionOrigin, EvaluationStatus, FrameworkId, LessonStage, PromptKind, PublicationStatus, RewriteStatus, ScoreTotals, TeachingUse } from './types.js';

export type ApiErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'unprocessable'
  | 'validation_failed'
  | 'quota_exceeded'
  | 'rate_limited'
  | 'service_unavailable'
  | 'internal';

export interface ApiError {
  code: ApiErrorCode | string;
  message: string;
  retryable: boolean;
  request_id: string;
}

export const CLIENT_KEY_MIN = 16;
export const CLIENT_KEY_MAX = 128;
export const CONFIRMED_TEXT_MIN = 1;
export const CONFIRMED_TEXT_MAX = 4000;
export const RECORDING_HARD_LIMIT_SECONDS = 90;
export const RECORDING_TARGET_SECONDS = { min: 30, max: 60 } as const;
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
export const ACCEPTED_AUDIO_MIME = ['audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac', 'audio/mpeg'] as const;

export type InputMode = 'voice' | 'typed';
export type SessionMode = 'daily' | 'lesson' | 'review' | 'mixed' | 'roleplay';
export type SessionStatus = 'active' | 'completed' | 'released' | 'expired' | 'deleted';

export type AttemptStage =
  | 'created'
  | 'uploading'
  | 'uploaded'
  | 'transcribing'
  | 'transcript_review'
  | 'evaluating'
  | 'feedback'
  | 'failed'
  | 'deleted';

export type JobType =
  | 'transcribe'
  | 'evaluate'
  | 'rewrite'
  | 'speech'
  | 'roleplay_turn'
  | 'roleplay_evaluate'
  | 'cleanup_assets'
  | 'delete_attempt'
  | 'delete_account'
  | 'reconcile_entitlement';

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface JobStatusDto {
  job_id: string;
  type: JobType;
  state: JobState;
  /** ID of the validated artifact when succeeded (evaluation_id, rewrite_id, asset_id, transcript revision...). */
  result_id: string | null;
  result_kind: 'transcript_revision' | 'evaluation' | 'rewrite' | 'asset' | 'roleplay_turn' | null;
  error: { code: string; message: string; retryable: boolean } | null;
  updated_at: string;
}

export interface CriterionDto {
  id: string;
  label: string;
  origin: CriterionOrigin;
  definition: string;
}

export interface FrameworkOutlineDto {
  id: FrameworkId;
  order: number;
  app_title: string;
  source_title: string;
  objective: string;
  rubric_version: string;
  framework_number: number;
  publication_status: PublicationStatus;
  criteria: CriterionDto[];
  lessons: Array<{ id: string; version: number; stage: LessonStage; title: string; publication_status: PublicationStatus }>;
}

export interface SourceExampleDto {
  example_id: string;
  text_verbatim: string;
  teaching_use: TeachingUse;
  editorial_note: string;
  source_filename: string;
  source_pages: number[];
  text_sha256: string;
}

export interface LessonDto {
  id: string;
  version: number;
  framework_id: FrameworkId;
  framework_number: number;
  app_title: string;
  stage: LessonStage;
  title: string;
  /** Editorial explanation; labeled as such in UI. */
  explanation: string;
  source_statement_verbatim: string;
  source_statement_page: number;
  source_file: string;
  primary_example: SourceExampleDto;
  examples: SourceExampleDto[];
  criteria: CriterionDto[];
  prompt: PromptDto | null;
  notice_task: string | null;
  recognition: RecognitionTaskDto | null;
  publication_status: PublicationStatus;
}

export interface RecognitionTaskDto {
  question: string;
  options: Array<{ id: string; text: string }>;
  /** Authored answer key; may be null while still under review. */
  answer_id: string | null;
  rationale: string | null;
  key_status: string;
}

export interface PromptDto {
  id: string;
  version: number;
  framework_id: FrameworkId;
  kind: PromptKind;
  level: number;
  prompt: string;
  target_seconds: { min: number; max: number };
  hard_limit_seconds: number;
  criteria: CriterionDto[];
  example_ids: string[];
  publication_status: PublicationStatus;
}

export interface AllowanceDto {
  plan: 'free' | 'pro';
  allowed_sessions: number;
  reserved: number;
  committed: number;
  remaining: number;
  /** UTC ISO timestamp when the window resets. */
  resets_at: string;
  scope: string[];
}

export interface TodayResponse {
  local_date: string;
  timezone: string;
  content_state: 'ready' | 'no_published_prompt';
  assignment: {
    id: string;
    framework: { id: FrameworkId; framework_number: number; app_title: string; objective: string; rubric_version: string };
    prompt: PromptDto;
    reason: 'review_due' | 'next_unit' | 'least_recent';
  } | null;
  allowance: AllowanceDto;
  pending_session: { session_id: string; attempt_id: string | null; stage: AttemptStage | null } | null;
  completed_today: { session_id: string; attempt_id: string; evaluation_id: string | null } | null;
  streak_days: number;
  next_units: Array<{ framework_id: FrameworkId; app_title: string; state: SkillState }>;
}

export interface CreateSessionRequest {
  client_key: string;
  mode: SessionMode;
  assignment_id?: string | undefined;
  prompt_id?: string | undefined;
  prompt_version?: number | undefined;
}

export interface SessionDto {
  session_id: string;
  mode: SessionMode;
  status: SessionStatus;
  framework_id: FrameworkId;
  framework_number: number;
  app_title: string;
  rubric_version: string;
  prompt: PromptDto;
  limits: {
    initial_recordings: number;
    transcript_corrections: number;
    guided_retries: number;
    rewrites_per_evaluation: number;
    speech_assets_per_rewrite: number;
    roleplay_exchanges: number;
  };
  allowance: AllowanceDto;
  created: boolean;
}

export interface CreateAttemptRequest {
  client_key: string;
  ordinal: number;
  retry_of?: string | null | undefined;
  input_mode: InputMode;
}

export interface AttemptDto {
  attempt_id: string;
  session_id: string;
  ordinal: number;
  retry_of: string | null;
  input_mode: InputMode;
  stage: AttemptStage;
  current_revision: number;
  media_bounds: { max_bytes: number; max_seconds: number; accepted_mime: string[] };
  transcript: {
    raw_text: string | null;
    confirmed_text: string | null;
    confirmed_revision: number | null;
    provider_meta: { duration_seconds: number | null; language: string | null; low_content: boolean } | null;
  };
  evaluation_id: string | null;
  evaluation_ids: string[];
  recoverable_error: { code: string; message: string; retryable: boolean; stage: string } | null;
  transcription_job_id: string | null;
  evaluation_job_id: string | null;
  created_at: string;
}

export interface UploadRequest {
  client_key: string;
  expected_bytes: number;
  mime: string;
  /** Advisory only; server measures the real file. */
  duration_seconds_hint?: number | undefined;
}

export interface UploadResponse {
  asset_id: string;
  upload_url: string;
  upload_token: string | null;
  expires_at: string;
  method: 'PUT' | 'POST';
  headers: Record<string, string>;
}

export interface ConfirmTranscriptRequest {
  client_key: string;
  expected_revision: number;
  confirmed_text: string;
}

export interface EvaluationDto {
  evaluation_id: string;
  attempt_id: string;
  transcript_revision: number;
  framework_id: FrameworkId;
  framework_number: number;
  rubric_version: string;
  status: EvaluationStatus;
  boundary_gate: BoundaryGate;
  confidence: Confidence;
  criteria: Array<{
    criterion_id: string;
    label: string;
    origin: CriterionOrigin;
    score: number | null;
    evidence_quotes: string[];
    reason: string;
  }>;
  strength: { evidence_quote: string; explanation: string } | null;
  priority_improvement: string;
  retry_instruction: string;
  totals: ScoreTotals;
  source_copy_flag: { example_id: string; note: string } | null;
  is_guided_retry: boolean;
  rewrite_id: string | null;
  created_at: string;
}

export interface RewriteDto {
  rewrite_id: string;
  evaluation_id: string;
  transcript_revision: number;
  status: RewriteStatus | 'validating' | 'rejected';
  rewrite_text: string | null;
  question_for_user: string | null;
  new_hypothetical: string | null;
  changes: Array<{ criterion_id: string; label: string; description: string }>;
  /** Only 'stronger_version' when validated improvement was demonstrated. */
  improvement_label: 'stronger_version' | 'another_way' | null;
  speech_asset_id: string | null;
  speech_state: 'none' | 'queued' | 'ready' | 'expired' | 'failed';
  created_at: string;
}

export interface PlaybackResponse {
  asset_id: string;
  url: string;
  expires_at: string;
  mime: string;
  duration_seconds: number | null;
  /** Always true for TTS assets. */
  ai_generated_voice: boolean;
  text: string | null;
}

export type SkillState = 'new' | 'developing' | 'ready' | 'review_due';

export interface ProgressResponse {
  xp_total: number;
  streak_days: number;
  practices_completed: number;
  skills: Array<{
    framework_id: FrameworkId;
    framework_number: number;
    app_title: string;
    state: SkillState;
    review_step: number;
    next_due_at: string | null;
    last_practiced_at: string | null;
    qualifying_attempts: number;
  }>;
  due_reviews: Array<{ framework_id: FrameworkId; app_title: string; due_at: string }>;
  history: Array<{
    session_id: string;
    attempt_id: string;
    framework_id: FrameworkId;
    app_title: string;
    local_day: string;
    displayed_total: number | null;
    total_maximum: number;
    is_guided_retry: boolean;
    retry_of: string | null;
    evaluation_id: string | null;
    created_at: string;
  }>;
  next_cursor: string | null;
}

export interface ComparisonResponse {
  session_id: string;
  framework_id: FrameworkId;
  app_title: string;
  rubric_version: string;
  first: { attempt_id: string; evaluation_id: string; displayed_total: number | null; total_maximum: number } | null;
  retry: { attempt_id: string; evaluation_id: string; displayed_total: number | null; total_maximum: number; guided: boolean } | null;
  state: 'ready' | 'no_comparable_result' | 'stale_revision' | 'retry_unavailable';
  per_criterion: Array<{ criterion_id: string; label: string; before: number | null; after: number | null; delta: number | null }>;
  mastery_note: string;
  next_review_at: string | null;
}

export interface PreferencesDto {
  goal: string | null;
  timezone: string;
  reminder_enabled: boolean;
  reminder_time: string | null;
  locale: string | null;
  onboarding_completed: boolean;
}

export interface EntitlementDto {
  plan: 'free' | 'pro';
  state: 'none' | 'pending' | 'active' | 'grace' | 'expired' | 'revoked';
  expires_at: string | null;
  source: 'none' | 'store' | 'demo';
  product_id: string | null;
  reconciled_at: string | null;
}

export interface RoleplayTurnRequest {
  client_key: string;
  attempt_id: string;
  transcript_revision: number;
  expected_exchange: number;
}

export interface RoleplayStateDto {
  session_id: string;
  scenario: string;
  partner_name: string;
  exchanges: Array<{
    exchange: number;
    attempt_id: string;
    learner_text: string | null;
    partner_reply: string | null;
    conversation_state: 'continuing' | 'ended' | null;
    boundary_signal: 'none' | 'uncertain' | 'disengaged' | null;
    partner_speech_asset_id: string | null;
  }>;
  exchanges_remaining: number;
  ended: boolean;
  session_evaluation_id: string | null;
}
