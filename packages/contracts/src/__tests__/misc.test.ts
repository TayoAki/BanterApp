import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validatePartnerReply } from '../partner.js';
import { toProviderStrictSchema } from '../provider-schema.js';
import { SCHEMAS } from '../schema.js';
import { detectSourceCopy } from '../similarity.js';
import { corpus, HANDOFF } from './fixtures.js';

describe('schema files match the handoff contracts byte for byte', () => {
  for (const [name, file] of [
    ['evaluation', 'evaluation.schema.json'],
    ['rewrite', 'rewrite.schema.json'],
    ['rewrite_verification', 'rewrite-verification.schema.json'],
    ['partner', 'partner.schema.json'],
  ] as const) {
    it(name, () => {
      const local = readFileSync(path.resolve(HANDOFF, '../packages/contracts/src/schemas', file));
      const source = readFileSync(path.join(HANDOFF, 'contracts', file));
      expect(createHash('sha256').update(local).digest('hex')).toBe(createHash('sha256').update(source).digest('hex'));
      expect(SCHEMAS[name]).toBeTruthy();
    });
  }
});

describe('toProviderStrictSchema', () => {
  it('strips metadata and string length bounds, converts const to enum, keeps strict objects', () => {
    const out = toProviderStrictSchema(SCHEMAS.evaluation as Record<string, unknown>);
    const json = JSON.stringify(out);
    expect(json).not.toContain('"$schema"');
    expect(json).not.toContain('maxLength');
    expect(json).not.toContain('"const"');
    const props = out['properties'] as Record<string, Record<string, unknown>>;
    expect(props['schema_version']?.['enum']).toEqual(['1.0']);
    expect(props['vocal_delivery_assessed']?.['enum']).toEqual([false]);
    expect(out['additionalProperties']).toBe(false);
    expect((out['required'] as string[]).sort()).toEqual(Object.keys(props).sort());
    // Nested anyOf (score integer|null) retained.
    const criteria = props['criteria']!;
    const items = criteria['items'] as Record<string, unknown>;
    const cprops = items['properties'] as Record<string, Record<string, unknown>>;
    expect(Array.isArray(cprops['score']?.['anyOf'])).toBe(true);
    expect(cprops['evidence_quotes']?.['maxItems']).toBe(2);
  });
});

describe('detectSourceCopy', () => {
  it('flags each supplied source example recited verbatim', () => {
    for (const ex of corpus.examples) {
      const r = detectSourceCopy(ex.text_verbatim, corpus.examples);
      expect(r.flagged, ex.example_id).toBe(true);
      expect(r.best?.example_id).toBe(ex.example_id);
    }
  });

  it('does not flag an original café answer or a short critique quoting a fragment', () => {
    const original = detectSourceCopy('I walked into the wrong café. I was trying to look like I’d planned it.', corpus.examples);
    expect(original.flagged).toBe(false);
    const critique = detectSourceCopy(
      'The example says "I hate old people" which I think is contempt, not banter. I would open with something I actually like instead.',
      corpus.examples,
    );
    expect(critique.flagged).toBe(false);
  });
});

describe('validatePartnerReply', () => {
  it('forces ended at the third exchange and rejects a fourth', () => {
    const ok = validatePartnerReply(
      { partner_reply: 'I have absolutely done that.', conversation_state: 'continuing', boundary_signal: 'none' },
      { exchangeNumber: 3 },
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.conversation_state).toBe('ended');
    const four = validatePartnerReply(
      { partner_reply: 'x', conversation_state: 'continuing', boundary_signal: 'none' },
      { exchangeNumber: 4 },
    );
    expect(four.ok).toBe(false);
  });
});
