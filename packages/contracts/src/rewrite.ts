import { validateRewriteSchema, validateRewriteVerificationSchema } from './schema.js';
import { codePointLength, findExactOrNormalized, isBlank, lowerWords, normalizeTypography, words } from './text.js';
import type { FrameworkConfig, Rewrite, RewriteVerification, ValidationResult } from './types.js';

export interface RewriteContext {
  framework: FrameworkConfig;
  assignedCriterionIds: readonly string[];
  expectedRevision: number;
  confirmedTranscript: string;
  /** Prompt text and any fictional scenario text supplied to the learner; names/numbers in it are not "invented". */
  allowedContextText?: string;
  /** Fictional exercises may add scenario-bounded detail. */
  fictional: boolean;
}

function fail(code: string, message: string, details?: Record<string, unknown>) {
  return { ok: false as const, code, message, ...(details ? { details } : {}) };
}

/** Maximum rewrite length relative to input, per "keep roughly the learner's length". */
export function rewriteLengthLimit(inputLength: number): number {
  return Math.max(3 * inputLength, inputLength + 300);
}

/**
 * Structural and lexical validation of a rewrite: schema, status consistency,
 * ID/revision match, changes reference assigned criteria, preserved-fact
 * citations occur where claimed, declared hypothetical occurs in the text,
 * bounded length. This verifies citations, not truth; see
 * deterministicFactSignals and the independent semantic verifier.
 */
export function validateRewrite(raw: unknown, ctx: RewriteContext): ValidationResult<Rewrite> {
  const schema = validateRewriteSchema(raw);
  if (!schema.ok) return fail(schema.code, schema.message, { errors: schema.errors });
  const rw = schema.value;
  const warnings: string[] = [];

  if (rw.framework_id !== ctx.framework.id) {
    return fail('framework_mismatch', `Rewrite framework ${rw.framework_id} does not match ${ctx.framework.id}.`);
  }
  if (rw.transcript_revision !== ctx.expectedRevision) {
    return fail('revision_mismatch', `Rewrite revision ${rw.transcript_revision} does not match ${ctx.expectedRevision}.`);
  }

  switch (rw.status) {
    case 'ready':
      if (rw.rewrite_text === null || isBlank(rw.rewrite_text)) return fail('status_inconsistent', 'ready requires nonempty rewrite_text.');
      if (rw.question_for_user !== null) return fail('status_inconsistent', 'ready must not include question_for_user.');
      break;
    case 'needs_detail':
      if (rw.rewrite_text !== null) return fail('status_inconsistent', 'needs_detail must not include rewrite_text.');
      if (rw.question_for_user === null || isBlank(rw.question_for_user)) return fail('status_inconsistent', 'needs_detail requires question_for_user.');
      break;
    case 'unavailable':
      if (rw.rewrite_text !== null) return fail('status_inconsistent', 'unavailable must not include rewrite_text.');
      break;
  }

  const assigned = new Set(ctx.assignedCriterionIds);
  for (const change of rw.changes) {
    if (!assigned.has(change.criterion_id)) {
      return fail('change_criterion_unknown', `Change references unassigned criterion ${change.criterion_id}.`);
    }
    if (isBlank(change.description)) return fail('change_blank', 'Change description is blank.');
  }

  if (rw.rewrite_text !== null) {
    const text = rw.rewrite_text;
    const inputLen = codePointLength(ctx.confirmedTranscript);
    if (codePointLength(text) > rewriteLengthLimit(inputLen)) {
      return fail('rewrite_too_long', 'Rewrite is far longer than the learner input.', {
        input_length: inputLen,
        rewrite_length: codePointLength(text),
      });
    }
    for (const fact of rw.preserved_facts) {
      const inMatch = findExactOrNormalized(ctx.confirmedTranscript, fact.input_quote);
      if (!inMatch.found) {
        return fail('preserved_fact_input_missing', 'A preserved_facts.input_quote does not occur in the confirmed transcript.', {
          input_quote: fact.input_quote,
        });
      }
      const outMatch = findExactOrNormalized(text, fact.rewrite_quote);
      if (!outMatch.found) {
        return fail('preserved_fact_rewrite_missing', 'A preserved_facts.rewrite_quote does not occur in the rewrite.', {
          rewrite_quote: fact.rewrite_quote,
        });
      }
      if (inMatch.normalized || outMatch.normalized) warnings.push('preserved fact matched after typographic normalization');
    }
    if (rw.new_hypothetical !== null) {
      const m = findExactOrNormalized(text, rw.new_hypothetical);
      if (!m.found) {
        return fail('hypothetical_not_in_rewrite', 'Declared new_hypothetical does not occur in the rewrite text.');
      }
    }
  } else if (rw.preserved_facts.length > 0) {
    return fail('status_inconsistent', 'preserved_facts require rewrite_text.');
  }

  return { ok: true, value: rw, warnings };
}

// ---------------------------------------------------------------------------
// Deterministic entity/number signals (additional signal, not a truth test)
// ---------------------------------------------------------------------------

// Cardinal quantity words only. Ordinals ("for a second", "first thing") and
// idiomatic words ("one day", "half asleep") are excluded to avoid false
// positives; digits are always checked.
const NUMBER_WORDS = new Set([
  'zero', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty',
  'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand', 'million', 'dozen',
]);

// Common sentence-initial or discourse words that are capitalized without being entities.
const CAPITALIZED_NON_ENTITIES = new Set([
  'i', "i'm", "i'd", "i've", "i'll", 'ok', 'okay', 'oh', 'ah', 'um', 'ever', 'so', 'and', 'but', 'then', 'for',
  'the', 'a', 'an', 'my', 'me', 'we', 'you', 'it', 'that', 'this', 'there', 'here', 'when', 'what', 'why', 'how',
  'honestly', 'anyway', 'like', 'well', 'yes', 'no', 'yeah', 'yea', 'god', 'wow', 'hey', 'hi', 'hello',
]);

export interface FactSignals {
  introduced_numbers: string[];
  introduced_entities: string[];
  /** Days/months are treated as entities too because they are checkable facts. */
  dropped_numbers: string[];
}

function numberTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of lowerWords(text)) {
    if (/^\d[\d,.:]*$/.test(w)) out.add(w.replace(/[,]/g, ''));
    else if (NUMBER_WORDS.has(w)) out.add(w);
  }
  for (const m of text.matchAll(/\d+(?:[.,]\d+)?/g)) out.add(m[0].replace(/,/g, ''));
  return out;
}

function sentenceInitialPositions(text: string): Set<number> {
  const norm = normalizeTypography(text);
  const positions = new Set<number>();
  const re = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
  let prevEnd = -1;
  let idx = 0;
  for (const m of norm.matchAll(re)) {
    const start = m.index ?? 0;
    const between = norm.slice(prevEnd < 0 ? 0 : prevEnd, start);
    if (prevEnd < 0 || /[.!?…"“”]\s*$/.test(between) || /^\s*["“”]?\s*$/.test(between) && prevEnd < 0) {
      positions.add(idx);
    }
    prevEnd = start + m[0].length;
    idx += 1;
  }
  return positions;
}

function entityTokens(text: string): Set<string> {
  const ws = words(text);
  const initials = sentenceInitialPositions(text);
  const out = new Set<string>();
  ws.forEach((w, i) => {
    const clean = w.replace(/^['’]+|['’]+$/g, '');
    if (!/^\p{Lu}/u.test(clean)) return;
    if (clean.length < 2) return;
    const lower = clean.toLowerCase();
    if (CAPITALIZED_NON_ENTITIES.has(lower)) return;
    if (initials.has(i)) return; // sentence-initial capitalization is not an entity signal
    if (/^[A-Z][a-z]*['’](s|d|ll|ve|re|m)$/.test(clean)) {
      out.add(clean.split(/['’]/)[0]!.toLowerCase());
      return;
    }
    out.add(lower);
  });
  return out;
}

/**
 * Numbers and capitalized mid-sentence tokens present in the rewrite but not
 * in the transcript or the allowed context (prompt/scenario). Heuristic:
 * treats results as signals for rejection/needs_detail, never as proof.
 */
export function deterministicFactSignals(
  confirmedTranscript: string,
  rewriteText: string,
  allowedContextText = '',
): FactSignals {
  const known = `${confirmedTranscript}\n${allowedContextText}`;
  const knownNumbers = numberTokens(known);
  const knownEntities = entityTokens(known);
  const knownLower = new Set(lowerWords(known));
  const rwNumbers = numberTokens(rewriteText);
  const rwEntities = entityTokens(rewriteText);
  const introduced_numbers = [...rwNumbers].filter((n) => !knownNumbers.has(n));
  const introduced_entities = [...rwEntities].filter((e) => !knownEntities.has(e) && !knownLower.has(e));
  const transcriptNumbers = numberTokens(confirmedTranscript);
  const dropped_numbers = [...transcriptNumbers].filter((n) => !rwNumbers.has(n));
  return { introduced_numbers, introduced_entities, dropped_numbers };
}

export function factSignalsBlockRewrite(signals: FactSignals): boolean {
  return signals.introduced_numbers.length > 0 || signals.introduced_entities.length > 0;
}

// ---------------------------------------------------------------------------
// Independent verifier output
// ---------------------------------------------------------------------------

export function validateRewriteVerification(
  raw: unknown,
  rewriteText: string,
): ValidationResult<RewriteVerification> {
  const schema = validateRewriteVerificationSchema(raw);
  if (!schema.ok) return fail(schema.code, schema.message, { errors: schema.errors });
  const v = schema.value;
  const warnings: string[] = [];
  for (const issue of v.issues) {
    if (isBlank(issue.rewrite_span)) return fail('issue_span_blank', 'Verifier issue has a blank span.');
    const m = findExactOrNormalized(rewriteText, issue.rewrite_span);
    if (!m.found) {
      // A span that is not in the rewrite is itself a hallucination; do not
      // let it pass as a valid issue list.
      return fail('issue_span_not_in_rewrite', 'Verifier cited a span that does not occur in the rewrite.', {
        span: issue.rewrite_span,
      });
    }
    if (m.normalized) warnings.push('verifier span matched after typographic normalization');
  }
  if (v.verdict !== 'pass' && v.issues.length === 0) {
    warnings.push('verifier returned a non-pass verdict without spans');
  }
  return { ok: true, value: v, warnings };
}

/**
 * Decide whether a validated rewrite may carry the "stronger version" label.
 * Requires: targeted deficient criterion improved, no source-rule criterion
 * lowered, boundary clear, and comparable displayed totals.
 */
export function rewriteImprovementVerdict(input: {
  original: { criteria: Array<{ criterion_id: string; score: number | null }>; boundary_gate: string; status: string };
  rewrite: { criteria: Array<{ criterion_id: string; score: number | null }>; boundary_gate: string; status: string };
  framework: FrameworkConfig;
  targetCriterionIds: readonly string[];
}): { label: 'stronger_version' | 'another_way' | 'not_improved'; reasons: string[] } {
  const reasons: string[] = [];
  if (input.rewrite.status !== 'scored' || input.rewrite.boundary_gate !== 'clear') {
    return { label: 'not_improved', reasons: ['rewrite_not_cleanly_scored'] };
  }
  if (input.original.status !== 'scored') {
    return { label: 'another_way', reasons: ['original_not_scored'] };
  }
  const before = new Map(input.original.criteria.map((c) => [c.criterion_id, c.score]));
  const after = new Map(input.rewrite.criteria.map((c) => [c.criterion_id, c.score]));
  const origin = new Map(input.framework.criteria.map((c) => [c.id, c.origin]));

  let lowered = false;
  for (const [id, b] of before) {
    const a = after.get(id);
    if (origin.get(id) === 'source_rule' && b !== null && a !== null && a !== undefined && a < b) {
      lowered = true;
      reasons.push(`lowered_${id}`);
    }
  }
  if (lowered) return { label: 'not_improved', reasons };

  const allMet = [...before.values()].every((s) => s !== null && s >= 2);
  if (allMet) return { label: 'another_way', reasons: ['input_already_meets_criteria'] };

  let improvedTarget = false;
  for (const id of input.targetCriterionIds) {
    const b = before.get(id);
    const a = after.get(id);
    if (b !== undefined && a !== undefined && b !== null && a !== null && a > b) {
      improvedTarget = true;
      reasons.push(`improved_${id}`);
    }
  }
  return improvedTarget ? { label: 'stronger_version', reasons } : { label: 'another_way', reasons: ['target_not_improved'] };
}
