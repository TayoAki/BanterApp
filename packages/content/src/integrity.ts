import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FRAMEWORK_IDS } from '@marshmemos/contracts';
import { corpus, examplesById, frameworks, frameworksById, lessons, prompts, promptsById, sourcesByFramework } from './load.js';
import { recognitionTasks } from './recognition.js';

export interface IntegrityReport {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const sha256 = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');

/**
 * Offline integrity checks mirroring handoff/scripts/validate_handoff.py, run
 * against the copies bundled in this package. `pdfDir` enables byte checks
 * of the original PDFs when they are available (server/test environments).
 */
export function checkContentIntegrity(options: { pdfDir?: string } = {}): IntegrityReport {
  const checks: IntegrityReport['checks'] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push(detail ? { name, ok, detail } : { name, ok });

  add('ten frameworks, F04/F09 absent', frameworks.length === 10 && !frameworksById.has('F04') && !frameworksById.has('F09'));
  add(
    'framework ids match contract enum',
    frameworks.every((f) => (FRAMEWORK_IDS as readonly string[]).includes(f.id)) && FRAMEWORK_IDS.every((id) => frameworksById.has(id)),
  );
  add('ten source documents, 44 pages', corpus.sources.length === 10 && corpus.sources.reduce((a, s) => a + s.page_count, 0) === 44);
  add('twenty examples', corpus.examples.length === 20);

  for (const e of corpus.examples) {
    const src = corpus.sources.find((s) => s.filename === e.source_filename);
    if (!src) {
      add(`example ${e.example_id} source present`, false, e.source_filename);
      continue;
    }
    const pageText = norm(src.pages.filter((p) => e.source_pages.includes(p.page)).map((p) => p.text_extracted).join(' '));
    add(`example ${e.example_id} verbatim in source pages`, pageText.includes(e.text_verbatim));
    add(`example ${e.example_id} sha256`, sha256(e.text_verbatim) === e.text_sha256);
    add(`example ${e.example_id} framework matches source`, src.framework_id === e.framework_id);
  }

  for (const f of frameworks) {
    const src = sourcesByFramework.get(f.id);
    add(`${f.id} source document`, !!src && src.filename === f.source_file);
    if (src) {
      const firstPage = src.pages.find((p) => p.page === 1);
      add(`${f.id} statement verbatim on page 1`, !!firstPage && norm(firstPage.text_extracted).includes(f.source_statement_verbatim));
    }
    add(`${f.id} three unique criteria`, new Set(f.criteria.map((c) => c.id)).size === 3 && f.criteria.length === 3);
    add(`${f.id} example ids belong to framework`, f.example_ids.every((id) => examplesById.get(id)?.framework_id === f.id));
    add(`${f.id} primary example listed`, f.example_ids.includes(f.primary_example_id));
    add(`${f.id} criterion origins valid`, f.criteria.every((c) => ['source_rule', 'example_derived', 'exercise_rule'].includes(c.origin)));
  }

  add('thirty unique prompts', new Set(prompts.map((p) => p.id)).size === 30 && prompts.length === 30);
  for (const p of prompts) {
    const f = frameworksById.get(p.framework_id);
    add(`${p.id} framework exists`, !!f);
    if (!f) continue;
    add(`${p.id} criteria are the framework criteria`, JSON.stringify(p.criterion_ids) === JSON.stringify(f.criteria.map((c) => c.id)));
    add(`${p.id} examples belong to framework`, p.example_ids.every((id) => examplesById.get(id)?.framework_id === p.framework_id));
    add(`${p.id} is draft seed`, p.publication_status === 'draft');
    add(`${p.id} hard limit 90s`, p.hard_limit_seconds === 90 && p.target_seconds.min === 30 && p.target_seconds.max === 60);
  }

  add('thirty unique lessons', new Set(lessons.map((l) => l.id)).size === 30 && lessons.length === 30);
  for (const l of lessons) {
    add(`${l.id} prompt matches framework`, promptsById.get(l.prompt_id)?.framework_id === l.framework_id);
    add(`${l.id} example matches framework`, examplesById.get(l.primary_example_id)?.framework_id === l.framework_id);
    add(`${l.id} is draft seed`, l.publication_status === 'draft');
  }
  const noticeLessons = lessons.filter((l) => l.stage === 'notice');
  add('every notice lesson has an authored recognition task', noticeLessons.every((l) => recognitionTasks.some((t) => t.lesson_id === l.id)));
  for (const t of recognitionTasks) {
    const lesson = lessons.find((l) => l.id === t.lesson_id);
    const ex = lesson ? examplesById.get(lesson.primary_example_id) : undefined;
    add(`${t.lesson_id} recognition options quote the primary example`, !!ex && t.options.every((o) => norm(ex.text_verbatim).includes(norm(o.text))));
    add(`${t.lesson_id} recognition answer is an option`, t.options.some((o) => o.id === t.answer_id));
    add(`${t.lesson_id} recognition criterion exists`, !!lesson && !!frameworksById.get(lesson.framework_id)?.criteria.some((c) => c.id === t.criterion_id));
  }

  if (options.pdfDir) {
    for (const s of corpus.sources) {
      const file = path.join(options.pdfDir, s.filename);
      if (!existsSync(file)) {
        add(`${s.filename} pdf present`, false, 'missing');
        continue;
      }
      add(`${s.filename} pdf sha256`, sha256(readFileSync(file)) === s.sha256_pdf);
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}
