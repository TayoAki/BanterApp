import { describe, expect, it } from 'vitest';
import { compareEvaluations, computeTotals, validateEvaluation } from '../evaluation.js';
import { validateEvaluationSchema } from '../schema.js';
import { clone, F02, F02_CRITERIA, f02Context, fixtureEvaluation, frameworks } from './fixtures.js';

describe('evaluation contract fixture', () => {
  it('passes schema and semantic validation with server totals 6/9, source 6/6, exercise 0/3', () => {
    const result = validateEvaluation(fixtureEvaluation, f02Context);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totals).toEqual({
      displayed_total: 6,
      total_maximum: 9,
      framework_subtotal: 6,
      framework_maximum: 6,
      exercise_subtotal: 0,
      exercise_maximum: 3,
      mastery_qualifies: true,
      withheld_reason: null,
    });
    const origins = result.value.criteriaWithOrigin.map((c) => [c.criterion_id, c.origin]);
    expect(origins).toEqual([
      ['ordinary_moment', 'source_rule'],
      ['personal_reaction', 'source_rule'],
      ['response_opening', 'example_derived'],
    ]);
  });

  it('rejects a score of 4 and an extra total field at the schema layer', () => {
    const bad = clone(fixtureEvaluation);
    (bad.criteria[0] as { score: number }).score = 4;
    expect(validateEvaluationSchema(bad).ok).toBe(false);
    const extra = { ...clone(fixtureEvaluation), total: 9 };
    expect(validateEvaluationSchema(extra).ok).toBe(false);
  });

  it('rejects a non-integer score', () => {
    const bad = clone(fixtureEvaluation);
    (bad.criteria[0] as { score: number }).score = 2.5;
    expect(validateEvaluationSchema(bad).ok).toBe(false);
  });
});

describe('semantic rules', () => {
  it('rejects evidence not present in the confirmed transcript (hallucinated quote)', () => {
    const bad = clone(fixtureEvaluation);
    bad.criteria[0]!.evidence_quotes = ['The barista laughed at me.'];
    const r = validateEvaluation(bad, f02Context);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('evidence_not_in_transcript');
  });

  it('accepts evidence that differs only by typographic quotes and records a warning', () => {
    const ev = clone(fixtureEvaluation);
    ev.criteria[1]!.evidence_quotes = ["I was trying to look like I'd planned it."];
    ev.strength = { evidence_quote: "I was trying to look like I'd planned it.", explanation: 'x' };
    const r = validateEvaluation(ev, f02Context);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('rejects a positive score without evidence', () => {
    const bad = clone(fixtureEvaluation);
    bad.criteria[0]!.evidence_quotes = [];
    const r = validateEvaluation(bad, f02Context);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('evidence_missing');
  });

  it('allows a zero with no evidence (absent feature)', () => {
    const r = validateEvaluation(fixtureEvaluation, f02Context);
    expect(r.ok).toBe(true);
  });

  it('rejects an unknown criterion id and a duplicated criterion', () => {
    const unknown = clone(fixtureEvaluation);
    unknown.criteria[2]!.criterion_id = 'charisma';
    const r1 = validateEvaluation(unknown, f02Context);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.code).toBe('criterion_set_mismatch');

    const dup = clone(fixtureEvaluation);
    dup.criteria[2]!.criterion_id = 'ordinary_moment';
    const r2 = validateEvaluation(dup, f02Context);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('criterion_duplicate');
  });

  it("rejects criteria borrowed from another framework's rules", () => {
    const borrowed = clone(fixtureEvaluation);
    borrowed.criteria[2]!.criterion_id = 'inner_view'; // F01 criterion
    const r = validateEvaluation(borrowed, f02Context);
    expect(r.ok).toBe(false);
  });

  it('rejects framework and revision mismatches', () => {
    const wrongFw = clone(fixtureEvaluation);
    wrongFw.framework_id = 'F01';
    expect(validateEvaluation(wrongFw, f02Context).ok).toBe(false);
    const wrongRev = clone(fixtureEvaluation);
    wrongRev.transcript_revision = 2;
    const r = validateEvaluation(wrongRev, f02Context);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('revision_mismatch');
  });

  it('rejects an arbitrary source example id', () => {
    const bad = clone(fixtureEvaluation);
    bad.source_example_ids = ['E12-01'];
    const r = validateEvaluation(bad, f02Context);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('source_id_unknown');
  });

  it('rejects a strength whose quote is not in the transcript', () => {
    const bad = clone(fixtureEvaluation);
    bad.strength = { evidence_quote: 'Everyone clapped.', explanation: 'no' };
    const r = validateEvaluation(bad, f02Context);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('strength_not_in_transcript');
  });

  it('requires all-null scores for insufficient_input and non-null for scored', () => {
    const insufficient = clone(fixtureEvaluation);
    insufficient.status = 'insufficient_input';
    expect(validateEvaluation(insufficient, f02Context).ok).toBe(false);
    for (const c of insufficient.criteria) {
      c.score = null;
      c.evidence_quotes = [];
    }
    insufficient.strength = null;
    const ok = validateEvaluation(insufficient, f02Context);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.totals.displayed_total).toBeNull();
      expect(ok.value.totals.withheld_reason).toBe('not_scored');
      expect(ok.value.totals.mastery_qualifies).toBe(false);
    }
    const scoredNull = clone(fixtureEvaluation);
    scoredNull.criteria[0]!.score = null;
    expect(validateEvaluation(scoredNull, f02Context).ok).toBe(false);
  });

  it('keeps status and boundary gate consistent for needs_revision', () => {
    const a = clone(fixtureEvaluation);
    a.status = 'needs_revision';
    expect(validateEvaluation(a, f02Context).ok).toBe(false);
    a.boundary_gate = 'needs_revision';
    const r = validateEvaluation(a, f02Context);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.totals.displayed_total).toBeNull();
  });
});

describe('computeTotals', () => {
  it('withholds the total for low confidence and for a non-clear boundary gate', () => {
    const low = { ...clone(fixtureEvaluation), confidence: 'low' as const };
    const t1 = computeTotals(low, F02, F02_CRITERIA);
    expect(t1.displayed_total).toBeNull();
    expect(t1.withheld_reason).toBe('low_confidence');
    expect(t1.mastery_qualifies).toBe(false);

    const uncertainGate = { ...clone(fixtureEvaluation), boundary_gate: 'uncertain' as const };
    const t2 = computeTotals(uncertainGate, F02, F02_CRITERIA);
    expect(t2.displayed_total).toBeNull();
    expect(t2.withheld_reason).toBe('boundary_not_clear');
  });

  it('never lowers the source-framework subtotal because an exercise target was missed', () => {
    const t = computeTotals(fixtureEvaluation, F02, F02_CRITERIA);
    expect(t.framework_subtotal).toBe(6);
    expect(t.framework_maximum).toBe(6);
    expect(t.exercise_subtotal).toBe(0);
    expect(t.mastery_qualifies).toBe(true);
  });

  it('mastery requires every source_rule criterion at 2 or more', () => {
    const ev = clone(fixtureEvaluation);
    ev.criteria[0]!.score = 1;
    const t = computeTotals(ev, F02, F02_CRITERIA);
    expect(t.displayed_total).toBe(4);
    expect(t.mastery_qualifies).toBe(false);
  });

  it('computes maximums for an all-source-rule framework (F05: 9/9 framework, 0 exercise)', () => {
    const f05 = frameworks.find((f) => f.id === 'F05')!;
    const ev = {
      status: 'scored' as const,
      confidence: 'high' as const,
      boundary_gate: 'clear' as const,
      criteria: f05.criteria.map((c) => ({ criterion_id: c.id, score: 2 as const, evidence_quotes: ['x'], reason: 'r' })),
    };
    const t = computeTotals(ev, f05, f05.criteria.map((c) => c.id));
    expect(t.framework_maximum).toBe(9);
    expect(t.exercise_maximum).toBe(0);
    expect(t.displayed_total).toBe(6);
  });

  it('throws if asked to total a scored evaluation with a missing assigned criterion', () => {
    const ev = clone(fixtureEvaluation);
    ev.criteria.pop();
    expect(() => computeTotals(ev, F02, F02_CRITERIA)).toThrow();
  });
});

describe('compareEvaluations', () => {
  it('produces per-criterion deltas for two validated results', () => {
    const first = validateEvaluation(fixtureEvaluation, f02Context);
    const retryEv = clone(fixtureEvaluation);
    retryEv.criteria[2]!.score = 2;
    retryEv.criteria[2]!.evidence_quotes = ['I walked into the wrong café.'];
    const second = validateEvaluation(retryEv, f02Context);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const cmp = compareEvaluations(first.value, second.value);
    expect(cmp.comparable).toBe(true);
    expect(cmp.total_before).toBe(6);
    expect(cmp.total_after).toBe(8);
    expect(cmp.per_criterion.find((c) => c.criterion_id === 'response_opening')?.delta).toBe(2);
  });
});
