import { validateEvaluationSchema } from './schema.js';
import { findExactOrNormalized, isBlank } from './text.js';
import type {
  CriterionConfig,
  Evaluation,
  EvaluationCriterion,
  FrameworkConfig,
  ScoreTotals,
  ValidationResult,
} from './types.js';

/**
 * Context the server resolves for the assigned exercise. Nothing here comes
 * from the model or from the client.
 */
export interface EvaluationContext {
  framework: FrameworkConfig;
  /** Exactly the criterion IDs declared by the assigned prompt (normally 3). */
  assignedCriterionIds: readonly string[];
  /** Transcript revision that was sent to the model. */
  expectedRevision: number;
  /** The confirmed transcript text of that revision (or joined learner turns). */
  confirmedTranscript: string;
  /** Source example IDs supplied to the model for this framework. */
  allowedSourceExampleIds: readonly string[];
}

export interface ValidatedEvaluation {
  evaluation: Evaluation;
  totals: ScoreTotals;
  /** Per-criterion origin resolved from framework config, for display. */
  criteriaWithOrigin: Array<EvaluationCriterion & { origin: CriterionConfig['origin']; label: string }>;
}

function fail(code: string, message: string, details?: Record<string, unknown>) {
  return { ok: false as const, code, message, ...(details ? { details } : {}) };
}

/**
 * Full validation: JSON Schema (necessary) plus the semantic rules from
 * docs/02-framework-engine.md (sufficient for publication). Returns totals
 * computed in ordinary server code.
 */
export function validateEvaluation(
  raw: unknown,
  ctx: EvaluationContext,
): ValidationResult<ValidatedEvaluation> {
  const schema = validateEvaluationSchema(raw);
  if (!schema.ok) return fail(schema.code, schema.message, { errors: schema.errors });
  const ev = schema.value;
  const warnings: string[] = [];

  if (ev.framework_id !== ctx.framework.id) {
    return fail('framework_mismatch', `Evaluation framework ${ev.framework_id} does not match assigned ${ctx.framework.id}.`);
  }
  if (ev.transcript_revision !== ctx.expectedRevision) {
    return fail('revision_mismatch', `Evaluation revision ${ev.transcript_revision} does not match confirmed revision ${ctx.expectedRevision}.`);
  }
  if (ev.vocal_delivery_assessed !== false) {
    return fail('vocal_delivery_claimed', 'Vocal delivery cannot be assessed from a transcript.');
  }

  // Exactly the assigned criterion IDs, each once.
  const assigned = new Set(ctx.assignedCriterionIds);
  if (assigned.size !== ctx.assignedCriterionIds.length) {
    return fail('context_invalid', 'Assigned criterion IDs must be unique.');
  }
  const configById = new Map(ctx.framework.criteria.map((c) => [c.id, c] as const));
  for (const id of assigned) {
    if (!configById.has(id)) return fail('context_invalid', `Assigned criterion ${id} is not part of ${ctx.framework.id}.`);
  }
  const returned = ev.criteria.map((c) => c.criterion_id);
  const returnedSet = new Set(returned);
  if (returnedSet.size !== returned.length) {
    return fail('criterion_duplicate', 'A criterion was returned more than once.', { returned });
  }
  if (returned.length !== assigned.size || returned.some((id) => !assigned.has(id))) {
    return fail('criterion_set_mismatch', 'Returned criteria are not exactly the assigned criteria.', {
      returned,
      assigned: [...assigned],
    });
  }

  // Source example IDs must come from this framework's supplied examples.
  const allowedSources = new Set(ctx.allowedSourceExampleIds);
  for (const id of ev.source_example_ids) {
    if (!allowedSources.has(id)) {
      return fail('source_id_unknown', `Source example ${id} was not supplied for ${ctx.framework.id}.`, {
        allowed: [...allowedSources],
      });
    }
  }

  // Status/score consistency.
  const scores = ev.criteria.map((c) => c.score);
  if (ev.status === 'insufficient_input' && scores.some((s) => s !== null)) {
    return fail('status_inconsistent', 'insufficient_input requires all scores to be null.');
  }
  if (ev.status === 'scored' && scores.some((s) => s === null)) {
    return fail('status_inconsistent', 'scored requires an integer score for every criterion.');
  }
  if (ev.status === 'needs_revision' && ev.boundary_gate !== 'needs_revision') {
    return fail('status_inconsistent', 'needs_revision status requires boundary_gate needs_revision.');
  }
  if (ev.boundary_gate === 'needs_revision' && ev.status !== 'needs_revision') {
    return fail('status_inconsistent', 'boundary_gate needs_revision requires status needs_revision.');
  }

  // Evidence must occur in the confirmed transcript; score > 0 needs evidence.
  const transcript = ctx.confirmedTranscript;
  for (const c of ev.criteria) {
    for (const quote of c.evidence_quotes) {
      if (isBlank(quote)) return fail('evidence_blank', `Blank evidence for ${c.criterion_id}.`);
      const m = findExactOrNormalized(transcript, quote);
      if (!m.found) {
        return fail('evidence_not_in_transcript', `Evidence for ${c.criterion_id} does not occur in the confirmed transcript.`, {
          criterion_id: c.criterion_id,
          quote,
        });
      }
      if (m.normalized) warnings.push(`evidence for ${c.criterion_id} matched after typographic normalization`);
    }
    if (c.score !== null && c.score > 0 && c.evidence_quotes.length === 0) {
      return fail('evidence_missing', `Score ${c.score} for ${c.criterion_id} has no supporting evidence.`, {
        criterion_id: c.criterion_id,
      });
    }
    if (isBlank(c.reason)) return fail('reason_blank', `Missing reason for ${c.criterion_id}.`);
  }

  if (ev.strength) {
    if (isBlank(ev.strength.evidence_quote)) return fail('strength_evidence_blank', 'Strength has no evidence.');
    const m = findExactOrNormalized(transcript, ev.strength.evidence_quote);
    if (!m.found) {
      return fail('strength_not_in_transcript', 'Strength evidence does not occur in the confirmed transcript.', {
        quote: ev.strength.evidence_quote,
      });
    }
    if (m.normalized) warnings.push('strength evidence matched after typographic normalization');
  }

  const totals = computeTotals(ev, ctx.framework, ctx.assignedCriterionIds);
  const criteriaWithOrigin = ev.criteria.map((c) => {
    const cfg = configById.get(c.criterion_id)!;
    return { ...c, origin: cfg.origin, label: cfg.label };
  });

  return { ok: true, value: { evaluation: ev, totals, criteriaWithOrigin }, warnings };
}

/**
 * Server totals per docs/02-framework-engine.md. Model output never chooses
 * these numbers. Assumes the evaluation already passed validateEvaluation
 * (criteria are exactly the assigned IDs).
 */
export function computeTotals(
  ev: Pick<Evaluation, 'status' | 'confidence' | 'boundary_gate' | 'criteria'>,
  framework: Pick<FrameworkConfig, 'criteria'>,
  assignedCriterionIds: readonly string[],
): ScoreTotals {
  const assigned = framework.criteria.filter((c) => assignedCriterionIds.includes(c.id));
  const sourceRule = assigned.filter((c) => c.origin === 'source_rule');
  const exercise = assigned.filter((c) => c.origin !== 'source_rule');
  const total_maximum = 3 * assigned.length;
  const framework_maximum = 3 * sourceRule.length;
  const exercise_maximum = 3 * exercise.length;

  const withheld: ScoreTotals['withheld_reason'] =
    ev.status !== 'scored'
      ? 'not_scored'
      : ev.confidence === 'low'
        ? 'low_confidence'
        : ev.boundary_gate !== 'clear'
          ? 'boundary_not_clear'
          : null;

  if (withheld) {
    return {
      displayed_total: null,
      total_maximum,
      framework_subtotal: null,
      framework_maximum,
      exercise_subtotal: null,
      exercise_maximum,
      mastery_qualifies: false,
      withheld_reason: withheld,
    };
  }

  const scoreOf = new Map<string, number>();
  for (const c of ev.criteria) {
    if (c.score === null || !Number.isInteger(c.score) || c.score < 0 || c.score > 3) {
      throw new Error(`computeTotals: scored evaluation has an invalid score for ${c.criterion_id}`);
    }
    scoreOf.set(c.criterion_id, c.score);
  }
  for (const c of assigned) {
    if (!scoreOf.has(c.id)) throw new Error(`computeTotals: missing score for assigned criterion ${c.id}`);
  }

  const sum = (list: CriterionConfig[]) => list.reduce((acc, c) => acc + (scoreOf.get(c.id) ?? 0), 0);
  const framework_subtotal = sum(sourceRule);
  const exercise_subtotal = sum(exercise);

  return {
    displayed_total: framework_subtotal + exercise_subtotal,
    total_maximum,
    framework_subtotal,
    framework_maximum,
    exercise_subtotal,
    exercise_maximum,
    mastery_qualifies: sourceRule.every((c) => (scoreOf.get(c.id) ?? 0) >= 2),
    withheld_reason: null,
  };
}

/**
 * Compares two validated evaluations of the same rubric for the comparison
 * screen. Only meaningful when both have displayed totals.
 */
export function compareEvaluations(
  first: { evaluation: Evaluation; totals: ScoreTotals },
  second: { evaluation: Evaluation; totals: ScoreTotals },
): {
  comparable: boolean;
  reason: string | null;
  per_criterion: Array<{ criterion_id: string; before: number | null; after: number | null; delta: number | null }>;
  total_before: number | null;
  total_after: number | null;
} {
  const ids = first.evaluation.criteria.map((c) => c.criterion_id);
  const sameSet =
    ids.length === second.evaluation.criteria.length &&
    ids.every((id) => second.evaluation.criteria.some((c) => c.criterion_id === id));
  const per_criterion = ids.map((id) => {
    const before = first.evaluation.criteria.find((c) => c.criterion_id === id)?.score ?? null;
    const after = second.evaluation.criteria.find((c) => c.criterion_id === id)?.score ?? null;
    return { criterion_id: id, before, after, delta: before !== null && after !== null ? after - before : null };
  });
  const comparable =
    sameSet &&
    first.evaluation.framework_id === second.evaluation.framework_id &&
    first.totals.displayed_total !== null &&
    second.totals.displayed_total !== null;
  return {
    comparable,
    reason: comparable
      ? null
      : !sameSet
        ? 'different_criteria'
        : first.totals.displayed_total === null || second.totals.displayed_total === null
          ? 'no_displayed_total'
          : 'framework_mismatch',
    per_criterion,
    total_before: first.totals.displayed_total,
    total_after: second.totals.displayed_total,
  };
}
