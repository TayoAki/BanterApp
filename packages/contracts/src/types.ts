/**
 * Shared domain types for marshmemos.
 *
 * Framework/criterion shapes mirror `handoff/content/frameworks.json`.
 * Model-output shapes mirror the JSON Schemas in `./schemas` (the local
 * authoritative response contracts). Server code, not model output,
 * computes totals, XP, mastery, quota, roles and paid access.
 */

export const FRAMEWORK_IDS = [
  'F01',
  'F02',
  'F05',
  'F06',
  'F03',
  'F10',
  'F08',
  'F07',
  'F11',
  'F12',
] as const;
export type FrameworkId = (typeof FRAMEWORK_IDS)[number];

/** Curriculum order from docs/01-product.md. Source IDs stay stable. */
export const CURRICULUM_ORDER: readonly FrameworkId[] = [
  'F01',
  'F02',
  'F05',
  'F06',
  'F03',
  'F10',
  'F08',
  'F07',
  'F11',
  'F12',
];

export function isFrameworkId(value: unknown): value is FrameworkId {
  return typeof value === 'string' && (FRAMEWORK_IDS as readonly string[]).includes(value);
}

export type CriterionOrigin = 'source_rule' | 'example_derived' | 'exercise_rule';

export interface CriterionConfig {
  id: string;
  label: string;
  origin: CriterionOrigin;
  source_pages: number[];
  definition: string;
  anchors: { '0': string; '1': string; '2': string; '3': string };
}

export interface FrameworkConfig {
  id: FrameworkId;
  order: number;
  app_title: string;
  source_title: string;
  source_file: string;
  source_pages: number[];
  source_statement_verbatim: string;
  source_statement_page: number;
  objective: string;
  example_ids: string[];
  primary_example_id: string;
  rubric_version: string;
  criteria: CriterionConfig[];
}

export type TeachingUse =
  | 'demonstration'
  | 'mixed_demo'
  | 'context_dependent'
  | 'comparison'
  | 'critique';

export interface SourceExample {
  example_id: string;
  framework_id: FrameworkId;
  source_filename: string;
  source_pages: number[];
  /** Exact source wording, whitespace-normalized only. Render directly. */
  text_verbatim: string;
  text_sha256: string;
  normalization: string;
  teaching_use: TeachingUse;
  /** Editorial addition; never presented as source wording. */
  editorial_note: string;
}

export type PromptKind = 'personal_reflection' | 'fictional_roleplay';
export type PublicationStatus = 'draft' | 'published' | 'retired';

export interface PromptSeed {
  id: string;
  framework_id: FrameworkId;
  level: number;
  kind: PromptKind;
  prompt: string;
  target_seconds: { min: number; max: number };
  hard_limit_seconds: number;
  criterion_ids: string[];
  example_ids: string[];
  publication_status: PublicationStatus;
  version: number;
}

export type LessonStage = 'notice' | 'build' | 'transfer';

export interface LessonSeed {
  id: string;
  framework_id: FrameworkId;
  stage: LessonStage;
  title: string;
  explanation: string;
  primary_example_id: string;
  prompt_id: string;
  source_usage: string;
  notice_task: string | null;
  recognition_answer_key_status: string;
  publication_status: PublicationStatus;
  version: number;
}

// ---------------------------------------------------------------------------
// Model output contracts (mirror ./schemas/*.json)
// ---------------------------------------------------------------------------

export type EvaluationStatus = 'scored' | 'insufficient_input' | 'uncertain' | 'needs_revision';
export type BoundaryGate = 'clear' | 'uncertain' | 'needs_revision';
export type Confidence = 'high' | 'medium' | 'low';

export interface EvaluationCriterion {
  criterion_id: string;
  score: 0 | 1 | 2 | 3 | null;
  evidence_quotes: string[];
  reason: string;
}

export interface EvaluationStrength {
  evidence_quote: string;
  explanation: string;
}

export interface Evaluation {
  schema_version: '1.0';
  framework_id: FrameworkId;
  transcript_revision: number;
  criteria: EvaluationCriterion[];
  status: EvaluationStatus;
  boundary_gate: BoundaryGate;
  confidence: Confidence;
  strength: EvaluationStrength | null;
  priority_improvement: string;
  retry_instruction: string;
  source_example_ids: string[];
  vocal_delivery_assessed: false;
}

export type RewriteStatus = 'ready' | 'needs_detail' | 'unavailable';

export interface PreservedFact {
  input_quote: string;
  rewrite_quote: string;
}

export interface RewriteChange {
  criterion_id: string;
  description: string;
}

export interface Rewrite {
  schema_version: '1.0';
  framework_id: FrameworkId;
  transcript_revision: number;
  status: RewriteStatus;
  rewrite_text: string | null;
  preserved_facts: PreservedFact[];
  changes: RewriteChange[];
  new_hypothetical: string | null;
  question_for_user: string | null;
}

export type VerificationVerdict = 'pass' | 'revise' | 'needs_detail';

export interface RewriteVerificationIssue {
  rewrite_span: string;
  explanation: string;
}

export interface RewriteVerification {
  verdict: VerificationVerdict;
  issues: RewriteVerificationIssue[];
}

export interface PartnerReply {
  partner_reply: string;
  conversation_state: 'continuing' | 'ended';
  boundary_signal: 'none' | 'uncertain' | 'disengaged';
}

// ---------------------------------------------------------------------------
// Server-computed results (never produced by a model)
// ---------------------------------------------------------------------------

export interface ScoreTotals {
  /** Null when status != scored, confidence == low, or boundary gate not clear. */
  displayed_total: number | null;
  /** Always 3 * assigned criteria count (normally 9). */
  total_maximum: number;
  framework_subtotal: number | null;
  framework_maximum: number;
  exercise_subtotal: number | null;
  exercise_maximum: number;
  /** Server decision: all source_rule scores >= 2 and gates clear. */
  mastery_qualifies: boolean;
  /** Why displayed_total is null, if it is. */
  withheld_reason: 'not_scored' | 'low_confidence' | 'boundary_not_clear' | null;
}

export type ValidationFailure = {
  ok: false;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type ValidationResult<T> = { ok: true; value: T; warnings: string[] } | ValidationFailure;
