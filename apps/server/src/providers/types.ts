import type { FrameworkConfig, SourceExample } from '@marshmemos/contracts';

/**
 * Provider adapter interfaces. Production wires OpenAI adapters; development
 * and tests may wire fixture adapters that implement the same contracts.
 * Adapters return raw model output; validation and totals live in the
 * pipeline, never in the adapter.
 */

export type ProviderErrorKind =
  | 'timeout'
  | 'rate_limited'
  | 'transient'
  | 'bad_input'
  | 'denied'
  | 'refusal'
  | 'incomplete'
  | 'malformed_output';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  /** True when the provider may have billed the call despite the failure. */
  readonly billingUncertain: boolean;

  constructor(kind: ProviderErrorKind, message: string, opts: { retryAfterMs?: number | null; billingUncertain?: boolean } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.retryable = kind === 'timeout' || kind === 'rate_limited' || kind === 'transient';
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.billingUncertain = opts.billingUncertain ?? kind === 'timeout';
  }
}

export interface TranscriptionResult {
  text: string;
  language: string | null;
  duration_seconds: number | null;
  /** Provider-supplied uncertainty, persisted as-is; never fabricated. */
  provider_meta: Record<string, unknown>;
  model: string;
}

export interface Transcriber {
  readonly model: string;
  transcribe(input: { bytes: Buffer; filename: string; mime: string; languageHint?: string }, opts: { timeoutMs: number; signal?: AbortSignal }): Promise<TranscriptionResult>;
}

export interface StructuredCallMeta {
  model: string;
  prompt_template_version: string;
  usage?: Record<string, unknown>;
  latency_ms: number;
}

export interface StructuredResult<T = unknown> {
  /** Parsed JSON from the model; still unvalidated. */
  raw: T;
  meta: StructuredCallMeta;
}

export interface EvaluationInput {
  framework: FrameworkConfig;
  criteria: FrameworkConfig['criteria'];
  examples: SourceExample[];
  source_context: string;
  rubric_version: string;
  prompt: { id: string; text: string; kind: string };
  confirmed_transcript: string;
  transcript_revision: number;
  input_mode: 'voice' | 'typed';
  scenario_context: string | null;
  is_guided_retry: boolean;
  /** Partner turns for a conversation task only when they actually exist. */
  partner_turns: Array<{ exchange: number; learner: string; partner: string | null }> | null;
}

/**
 * Bounded repair retry. `note` is fixed server text keyed by the failure code
 * (safe for the instruction channel); `details` may contain model- or
 * learner-derived strings and therefore travels only in the data envelope.
 */
export interface RepairRequest {
  code: string;
  note: string;
  details?: unknown;
}

export interface FrameworkEvaluator {
  readonly model: string;
  evaluate(input: EvaluationInput, opts: { timeoutMs: number; repair?: RepairRequest }): Promise<StructuredResult>;
}

export interface RewriteInput {
  framework: FrameworkConfig;
  criteria: FrameworkConfig['criteria'];
  examples: SourceExample[];
  rubric_version: string;
  prompt: { id: string; text: string; kind: string };
  confirmed_transcript: string;
  transcript_revision: number;
  evaluation: unknown;
  fictional: boolean;
  scenario_context: string | null;
}

export interface Rewriter {
  readonly model: string;
  rewrite(input: RewriteInput, opts: { timeoutMs: number; repair?: RepairRequest }): Promise<StructuredResult>;
}

export interface VerifyInput {
  confirmed_transcript: string;
  rewrite_text: string;
  task: string;
  criteria: FrameworkConfig['criteria'];
  fictional: boolean;
  scenario_context: string | null;
}

export interface RewriteVerifier {
  readonly model: string;
  verify(input: VerifyInput, opts: { timeoutMs: number }): Promise<StructuredResult>;
}

export interface PartnerInput {
  scenario: string;
  partner_facts: string;
  prior_turns: Array<{ exchange: number; learner: string; partner: string | null }>;
  learner_turn: string;
  turns_remaining: number;
}

export interface PartnerModel {
  readonly model: string;
  reply(input: PartnerInput, opts: { timeoutMs: number }): Promise<StructuredResult>;
}

export interface SpeechResult {
  bytes: Buffer;
  mime: string;
  model: string;
  voice: string;
}

export interface SpeechSynthesizer {
  readonly model: string;
  readonly voice: string;
  synthesize(input: { text: string; voice?: string }, opts: { timeoutMs: number }): Promise<SpeechResult>;
}

export interface EntitlementSnapshot {
  state: 'none' | 'pending' | 'active' | 'grace' | 'expired' | 'revoked';
  product_id: string | null;
  expires_at: Date | null;
  grace_until: Date | null;
  environment: 'sandbox' | 'production' | 'demo' | null;
  provider_customer_id: string | null;
}

export interface EntitlementProvider {
  readonly name: 'revenuecat' | 'none' | 'demo';
  /** Fetches current verified state from the provider (server-to-server). */
  fetch(appUserId: string): Promise<EntitlementSnapshot>;
  /** Verifies a webhook's authenticity; returns false on any doubt. */
  verifyWebhook(headers: Record<string, string | undefined>, rawBody: string): boolean;
}

export interface Providers {
  mode: 'live' | 'fixture';
  transcriber: Transcriber;
  evaluator: FrameworkEvaluator;
  rewriter: Rewriter;
  verifier: RewriteVerifier;
  partner: PartnerModel;
  speech: SpeechSynthesizer;
  entitlements: EntitlementProvider;
}
