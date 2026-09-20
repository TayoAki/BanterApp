import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkContentIntegrity } from '../integrity.js';
import { compareByCurriculum, CURRICULUM_ORDER, nextUnlockedFramework } from '../curriculum.js';
import { corpus, frameworkNumber, frameworks, lessons, prompts } from '../load.js';
import { effectiveStatus, loadManifest, visibleTo } from '../publication.js';
import { recognitionTasks } from '../recognition.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HANDOFF = path.resolve(here, '../../../../handoff');
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

describe('bundled content equals the handoff packet', () => {
  const manifest = JSON.parse(readFileSync(path.join(HANDOFF, 'MANIFEST.json'), 'utf8')) as { files: Array<{ path: string; sha256: string }> };
  for (const file of ['frameworks.json', 'source-corpus.json', 'daily-prompts.json', 'lessons.json']) {
    it(file, () => {
      const local = sha(path.resolve(here, '../../data', file));
      const entry = manifest.files.find((f) => f.path === `content/${file}`);
      expect(entry?.sha256).toBe(local);
      expect(sha(path.join(HANDOFF, 'content', file))).toBe(local);
    });
  }
});

describe('integrity', () => {
  it('passes every check including original PDF hashes', () => {
    const report = checkContentIntegrity({ pdfDir: path.join(HANDOFF, 'content/source-pdfs') });
    const failed = report.checks.filter((c) => !c.ok);
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(report.checks.length).toBeGreaterThan(200);
  });

  it('has a recognition task for each of the ten Notice lessons', () => {
    const notice = lessons.filter((l) => l.stage === 'notice').map((l) => l.id).sort();
    expect(recognitionTasks.map((t) => t.lesson_id).sort()).toEqual(notice);
    for (const t of recognitionTasks) expect(t.key_status).toBe('authored_draft_pending_review');
  });
});

describe('curriculum', () => {
  it('uses the product order and stable ids', () => {
    expect(CURRICULUM_ORDER).toEqual(['F01', 'F02', 'F05', 'F06', 'F03', 'F10', 'F08', 'F07', 'F11', 'F12']);
    expect(frameworks.map((f) => f.id)).toEqual([...CURRICULUM_ORDER]);
    expect(frameworks.map((f) => f.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(frameworkNumber('F12')).toBe(12);
  });

  it('unlocks the next unit and sorts by curriculum then prompt id', () => {
    expect(nextUnlockedFramework(new Set())).toBe('F01');
    expect(nextUnlockedFramework(new Set(['F01', 'F02']))).toBe('F05');
    expect(nextUnlockedFramework(new Set(CURRICULUM_ORDER))).toBeNull();
    const sorted = [...prompts].sort(compareByCurriculum).map((p) => p.id);
    expect(sorted.slice(0, 4)).toEqual(['F01-P01', 'F01-P02', 'F01-P03', 'F02-P01']);
    expect(sorted.at(-1)).toBe('F12-P03');
  });
});

describe('publication', () => {
  it('a seed without a manifest entry stays a draft: hidden from learners, visible to editors', () => {
    const m = { ...loadManifest('production'), frameworks: {}, prompts: {}, lessons: {}, examples: {} };
    for (const p of prompts) {
      const status = effectiveStatus(m, 'prompts', p.id, p.publication_status);
      expect(status).toBe('draft');
      expect(visibleTo({ editor: false }, status)).toBe(false);
      expect(visibleTo({ editor: true }, status)).toBe(true);
    }
  });

  it('the production manifest publishes exactly the shipped seeds (no dangling or missing IDs)', () => {
    const m = loadManifest('production');
    expect(m.publish_all_drafts).toBeUndefined();
    expect(Object.keys(m.frameworks).sort()).toEqual(frameworks.map((f) => f.id).sort());
    expect(Object.keys(m.prompts).sort()).toEqual(prompts.map((p) => p.id).sort());
    expect(Object.keys(m.lessons).sort()).toEqual(lessons.map((l) => l.id).sort());
    expect(Object.keys(m.examples).sort()).toEqual(corpus.examples.map((e) => e.example_id).sort());
    for (const kind of ['frameworks', 'prompts', 'lessons', 'examples'] as const) {
      for (const entry of Object.values(m[kind])) expect(['published', 'retired']).toContain(entry.status);
    }
    expect(m.note).toMatch(/rights/);
  });

  it('development preview publishes drafts but is labeled as such', () => {
    const m = loadManifest('development');
    expect(m.publish_all_drafts).toBe(true);
    expect(m.note).toMatch(/DEVELOPMENT PREVIEW ONLY/);
    expect(effectiveStatus(m, 'lessons', 'F02-L01', 'draft')).toBe('published');
  });

  it('an explicit manifest entry overrides the seed status', () => {
    const m = { ...loadManifest('production'), prompts: { 'F02-P01': { status: 'published' as const } } };
    expect(effectiveStatus(m, 'prompts', 'F02-P01', 'draft')).toBe('published');
    expect(effectiveStatus(m, 'prompts', 'F02-P02', 'draft')).toBe('draft');
  });
});
