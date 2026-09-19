import {
  detectSourceCopy,
  validateEvaluation,
  type Evaluation,
  type FrameworkConfig,
  type ScoreTotals,
  type SourceExample,
  type ValidationResult,
} from '@marshmemos/contracts';
import type { ServerContext } from '../context.js';
import type { CatalogFramework } from '../content/catalog.js';
import type { EvaluationInput, StructuredResult } from '../providers/types.js';
import { ProviderError } from '../providers/types.js';

export interface EvaluationSubject {
  framework: CatalogFramework;
  prompt: { id: string; text: string; kind: string; criterion_ids: string[] };
  confirmedText: string;
  transcriptRevision: number;
  inputMode: 'voice' | 'typed';
  isGuidedRetry: boolean;
  partnerTurns: EvaluationInput['partner_turns'];
}

export interface EvaluatedSubject {
  evaluation: Evaluation;
  totals: ScoreTotals;
  sourceCopy: { example_id: string; note: string } | null;
  meta: StructuredResult['meta'];
  warnings: string[];
  repaired: boolean;
}

export class InvalidModelOutputError extends Error {
  constructor(
    readonly stage: string,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'InvalidModelOutputError';
  }
}

export function buildEvaluationInput(ctx: ServerContext, subject: EvaluationSubject): EvaluationInput {
  const fw = subject.framework;
  const criteria = fw.config.criteria.filter((c) => subject.prompt.criterion_ids.includes(c.id));
  const examples: SourceExample[] = fw.examples.map((e) => e.example);
  return {
    framework: fw.config,
    criteria,
    examples,
    source_context: fw.sourcePagesText,
    rubric_version: fw.config.rubric_version,
    prompt: { id: subject.prompt.id, text: subject.prompt.text, kind: subject.prompt.kind },
    confirmed_transcript: subject.confirmedText,
    transcript_revision: subject.transcriptRevision,
    input_mode: subject.inputMode,
    scenario_context: subject.prompt.kind === 'fictional_roleplay' ? subject.prompt.text : null,
    is_guided_retry: subject.isGuidedRetry,
    partner_turns: subject.partnerTurns,
  };
}

/**
 * One evaluator call plus at most one schema/semantic repair retry, then
 * full validation and server totals. Never publishes an invalid result.
 */
export async function evaluateSubject(ctx: ServerContext, subject: EvaluationSubject, opts: { cachedRaw?: unknown } = {}): Promise<EvaluatedSubject> {
  const input = buildEvaluationInput(ctx, subject);
  const validationCtx = {
    framework: subject.framework.config,
    assignedCriterionIds: subject.prompt.criterion_ids,
    expectedRevision: subject.transcriptRevision,
    confirmedTranscript: subject.confirmedText,
    allowedSourceExampleIds: subject.framework.config.example_ids,
  };
  let repaired = false;
  let result: StructuredResult;
  let validation: ValidationResult<ReturnType<typeof validateEvaluation> extends ValidationResult<infer T> ? T : never>;

  if (opts.cachedRaw !== undefined) {
    result = { raw: opts.cachedRaw, meta: { model: 'checkpoint', prompt_template_version: ctx.config.PROMPT_CONFIG_VERSION, latency_ms: 0 } };
    validation = validateEvaluation(result.raw, validationCtx);
    if (validation.ok) return finish(validation.value, result, subject, repaired);
  }

  result = await ctx.providers.evaluator.evaluate(input, { timeoutMs: ctx.config.TIMEOUT_EVALUATE_MS });
  validation = validateEvaluation(result.raw, validationCtx);
  if (!validation.ok) {
    repaired = true;
    const repair = {
      code: validation.code,
      note: `The previous output was rejected by the validator. Return exactly the assigned criterion IDs once each, the provided transcript revision, only exact substrings of the confirmed transcript as evidence, and only the provided source example IDs.`,
      details: { message: validation.message, ...(validation.details ?? {}) },
    };
    result = await ctx.providers.evaluator.evaluate(input, { timeoutMs: ctx.config.TIMEOUT_EVALUATE_MS, repair });
    validation = validateEvaluation(result.raw, validationCtx);
    if (!validation.ok) {
      throw new InvalidModelOutputError('evaluate', validation.code, validation.message, validation.details);
    }
  }
  return finish(validation.value, result, subject, repaired);
}

function finish(
  value: { evaluation: Evaluation; totals: ScoreTotals },
  result: StructuredResult,
  subject: EvaluationSubject,
  repaired: boolean,
): EvaluatedSubject {
  const copy = detectSourceCopy(
    subject.confirmedText,
    subject.framework.examples.map((e) => ({ example_id: e.example.example_id, text_verbatim: e.example.text_verbatim })),
  );
  return {
    evaluation: value.evaluation,
    totals: value.totals,
    sourceCopy: copy.flagged && copy.best
      ? {
          example_id: copy.best.example_id,
          note: 'This closely matches a source example. Original practice needs your own material; similarity is a label, not a verdict, and you can clarify.',
        }
      : null,
    meta: result.meta,
    warnings: [],
    repaired,
  };
}

/** Bounded backoff honoring provider retry-after when present. */
export function backoffFor(err: unknown, attempt: number): { retryable: boolean; delayMs: number; code: string; message: string; billingUncertain: boolean } {
  if (err instanceof ProviderError) {
    const base = err.retryAfterMs ?? Math.min(5_000 * 2 ** Math.max(attempt - 1, 0), 60_000);
    return { retryable: err.retryable, delayMs: base, code: `provider_${err.kind}`, message: err.message, billingUncertain: err.billingUncertain };
  }
  if (err instanceof InvalidModelOutputError) {
    return { retryable: false, delayMs: 0, code: 'invalid_model_output', message: err.message, billingUncertain: false };
  }
  if (err instanceof Error && /ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket/i.test(err.message)) {
    return { retryable: true, delayMs: Math.min(5_000 * 2 ** attempt, 60_000), code: 'network', message: err.message, billingUncertain: true };
  }
  return { retryable: false, delayMs: 0, code: 'internal', message: err instanceof Error ? err.message : String(err), billingUncertain: false };
}

export function frameworkOrThrow(ctx: ServerContext, frameworkId: string): CatalogFramework {
  const fw = ctx.catalog.framework(frameworkId);
  if (!fw) throw new InvalidModelOutputError('content', 'framework_missing', `Framework ${frameworkId} is not in the catalog.`);
  return fw;
}

export type { FrameworkConfig };
