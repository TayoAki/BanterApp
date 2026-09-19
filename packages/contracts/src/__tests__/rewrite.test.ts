import { describe, expect, it } from 'vitest';
import {
  deterministicFactSignals,
  factSignalsBlockRewrite,
  rewriteImprovementVerdict,
  validateRewrite,
  validateRewriteVerification,
} from '../rewrite.js';
import { clone, F02, F02_CRITERIA, fixtureAttempt, fixtureEvaluation, fixtureRewrite } from './fixtures.js';

const ctx = {
  framework: F02,
  assignedCriterionIds: F02_CRITERIA,
  expectedRevision: 1,
  confirmedTranscript: fixtureAttempt.confirmed_transcript,
  fictional: false,
};

describe('rewrite fixture', () => {
  it('validates lexically and has no introduced entities or numbers', () => {
    const r = validateRewrite(fixtureRewrite, ctx);
    expect(r.ok).toBe(true);
    const signals = deterministicFactSignals(ctx.confirmedTranscript, fixtureRewrite.rewrite_text!);
    expect(signals.introduced_numbers).toEqual([]);
    expect(signals.introduced_entities).toEqual([]);
    expect(factSignalsBlockRewrite(signals)).toBe(false);
  });

  it('rejects a preserved fact whose input quote is not in the transcript', () => {
    const bad = clone(fixtureRewrite);
    bad.preserved_facts[0]!.input_quote = 'I walked into the right café.';
    const r = validateRewrite(bad, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('preserved_fact_input_missing');
  });

  it('rejects a rewrite quote that is not in the rewrite text', () => {
    const bad = clone(fixtureRewrite);
    bad.preserved_facts[1]!.rewrite_quote = 'the barista laughed';
    const r = validateRewrite(bad, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('preserved_fact_rewrite_missing');
  });

  it('flags "the barista laughed" as an introduced claim via the semantic verifier path (entity heuristics alone do not catch lowercase nouns)', () => {
    const rewritten = `${fixtureRewrite.rewrite_text} The barista laughed.`;
    const signals = deterministicFactSignals(ctx.confirmedTranscript, rewritten);
    // Deterministic checks are a signal, not a truth test: the lexical layer
    // passes this, which is exactly why the independent verifier is required.
    expect(signals.introduced_entities).toEqual([]);
    const verifier = validateRewriteVerification(
      { verdict: 'revise', issues: [{ rewrite_span: 'The barista laughed.', explanation: 'Not in the original.' }] },
      rewritten,
    );
    expect(verifier.ok).toBe(true);
    if (verifier.ok) expect(verifier.value.verdict).toBe('revise');
  });

  it('flags introduced numbers and named entities deterministically', () => {
    const signals = deterministicFactSignals(
      ctx.confirmedTranscript,
      'I walked into the wrong café with Maria and ordered 3 coffees. Ever done that?',
    );
    expect(signals.introduced_numbers).toContain('3');
    expect(signals.introduced_entities).toContain('maria');
    expect(factSignalsBlockRewrite(signals)).toBe(true);
  });

  it('does not flag entities that appear in the prompt/scenario context', () => {
    const signals = deterministicFactSignals(
      'We sang badly.',
      'You and Sam sang badly at karaoke.',
      'Fictional practice: your friend Sam loves terrible karaoke.',
    );
    expect(signals.introduced_entities).toEqual([]);
  });

  it('ignores sentence-initial capitalization and the pronoun I', () => {
    const signals = deterministicFactSignals('i felt silly. i kept walking.', 'Honestly, I felt silly. Then I kept walking.');
    expect(signals.introduced_entities).toEqual([]);
  });

  it('enforces status consistency', () => {
    const needsDetail = clone(fixtureRewrite);
    needsDetail.status = 'needs_detail';
    expect(validateRewrite(needsDetail, ctx).ok).toBe(false);
    needsDetail.rewrite_text = null;
    needsDetail.preserved_facts = [];
    needsDetail.question_for_user = 'What did you order once you sat down?';
    expect(validateRewrite(needsDetail, ctx).ok).toBe(true);

    const readyNoText = clone(fixtureRewrite);
    readyNoText.rewrite_text = null;
    readyNoText.preserved_facts = [];
    expect(validateRewrite(readyNoText, ctx).ok).toBe(false);
  });

  it('rejects changes that reference unassigned criteria and grossly long rewrites', () => {
    const bad = clone(fixtureRewrite);
    bad.changes[0]!.criterion_id = 'inner_view';
    expect(validateRewrite(bad, ctx).ok).toBe(false);

    const long = clone(fixtureRewrite);
    long.rewrite_text = `${fixtureRewrite.rewrite_text} ${'and then '.repeat(80)}`;
    long.preserved_facts = [];
    const r = validateRewrite(long, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('rewrite_too_long');
  });

  it('requires a declared hypothetical to occur in the rewrite', () => {
    const rw = clone(fixtureRewrite);
    rw.new_hypothetical = 'Imagine if the barista had bowed.';
    expect(validateRewrite(rw, ctx).ok).toBe(false);
    rw.rewrite_text = `${fixtureRewrite.rewrite_text} Imagine if the barista had bowed.`;
    expect(validateRewrite(rw, ctx).ok).toBe(true);
  });

  it('rejects a verifier issue span that does not occur in the rewrite', () => {
    const r = validateRewriteVerification(
      { verdict: 'revise', issues: [{ rewrite_span: 'not present anywhere', explanation: 'x' }] },
      fixtureRewrite.rewrite_text!,
    );
    expect(r.ok).toBe(false);
  });
});

describe('rewriteImprovementVerdict', () => {
  const original = { criteria: fixtureEvaluation.criteria, boundary_gate: 'clear', status: 'scored' };

  it('labels stronger_version only when the target improves without lowering source rules', () => {
    const better = clone(fixtureEvaluation);
    better.criteria[2]!.score = 2;
    const v = rewriteImprovementVerdict({
      original,
      rewrite: { criteria: better.criteria, boundary_gate: 'clear', status: 'scored' },
      framework: F02,
      targetCriterionIds: ['response_opening'],
    });
    expect(v.label).toBe('stronger_version');
  });

  it('refuses stronger_version when a source-rule criterion drops', () => {
    const worse = clone(fixtureEvaluation);
    worse.criteria[2]!.score = 3;
    worse.criteria[0]!.score = 1;
    const v = rewriteImprovementVerdict({
      original,
      rewrite: { criteria: worse.criteria, boundary_gate: 'clear', status: 'scored' },
      framework: F02,
      targetCriterionIds: ['response_opening'],
    });
    expect(v.label).toBe('not_improved');
  });

  it('labels another_way when the input already met every criterion', () => {
    const full = clone(fixtureEvaluation);
    full.criteria[2]!.score = 2;
    const v = rewriteImprovementVerdict({
      original: { criteria: full.criteria, boundary_gate: 'clear', status: 'scored' },
      rewrite: { criteria: full.criteria, boundary_gate: 'clear', status: 'scored' },
      framework: F02,
      targetCriterionIds: [],
    });
    expect(v.label).toBe('another_way');
  });

  it('never labels a rewrite with a boundary problem as an improvement', () => {
    const v = rewriteImprovementVerdict({
      original,
      rewrite: { criteria: fixtureEvaluation.criteria, boundary_gate: 'needs_revision', status: 'needs_revision' },
      framework: F02,
      targetCriterionIds: ['response_opening'],
    });
    expect(v.label).toBe('not_improved');
  });
});
