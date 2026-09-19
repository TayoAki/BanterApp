import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROMPT_TEMPLATES } from '../providers/prompts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

describe('runtime prompt templates', () => {
  for (const f of ['evaluate.md', 'rewrite.md', 'verify-rewrite.md', 'roleplay.md']) {
    it(`${f} equals the handoff copy`, () => {
      expect(sha(path.resolve(here, '../../prompts', f))).toBe(sha(path.resolve(here, '../../../../handoff/prompts', f)));
    });
  }
  it('extracts the instruction blocks and keeps the no-total rule', () => {
    expect(PROMPT_TEMPLATES.evaluate).toMatch(/Never emit a total, XP, entitlement, mastery/);
    expect(PROMPT_TEMPLATES.rewrite).toMatch(/needs_detail/);
    expect(PROMPT_TEMPLATES.verify).toMatch(/verdict pass, revise, or needs_detail/);
    expect(PROMPT_TEMPLATES.roleplay).toMatch(/turn limit/);
  });
});
