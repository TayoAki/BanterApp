import { createHash } from 'node:crypto';
import type {
  CriterionDto,
  FrameworkConfig,
  FrameworkOutlineDto,
  LessonDto,
  LessonSeed,
  PromptDto,
  PromptSeed,
  PublicationStatus,
  RecognitionTaskDto,
  SourceExample,
  SourceExampleDto,
} from '@marshmemos/contracts';
import {
  corpus,
  effectiveStatus,
  frameworkNumber,
  frameworks,
  lessons,
  loadManifest,
  prompts,
  recognitionByLesson,
  sourcesByFramework,
  visibleTo,
  type ManifestName,
  type PublicationManifest,
  type Viewer,
} from '@marshmemos/content';
import type { Db } from '../db/client.js';

/**
 * The runtime catalog: reviewed content with effective publication status
 * under the configured manifest. Source quotes are always rendered from the
 * corpus records, never from model output.
 */
export interface CatalogFramework {
  config: FrameworkConfig;
  status: PublicationStatus;
  examples: Array<{ example: SourceExample; status: PublicationStatus }>;
  prompts: Array<{ seed: PromptSeed; status: PublicationStatus }>;
  lessons: Array<{ seed: LessonSeed; status: PublicationStatus }>;
  /** Page text for the evaluator's source context (data, never instructions). */
  sourcePagesText: string;
}

export class Catalog {
  readonly manifest: PublicationManifest;
  readonly frameworks: ReadonlyMap<string, CatalogFramework>;
  readonly promptsById: ReadonlyMap<string, { seed: PromptSeed; status: PublicationStatus }>;
  readonly lessonsById: ReadonlyMap<string, { seed: LessonSeed; status: PublicationStatus }>;
  readonly examplesById: ReadonlyMap<string, { example: SourceExample; status: PublicationStatus }>;

  constructor(manifestName: ManifestName) {
    this.manifest = loadManifest(manifestName);
    const m = this.manifest;
    const fw = new Map<string, CatalogFramework>();
    const pById = new Map<string, { seed: PromptSeed; status: PublicationStatus }>();
    const lById = new Map<string, { seed: LessonSeed; status: PublicationStatus }>();
    const eById = new Map<string, { example: SourceExample; status: PublicationStatus }>();
    for (const f of frameworks) {
      const src = sourcesByFramework.get(f.id);
      const examples = corpus.examples
        .filter((e) => e.framework_id === f.id)
        .map((example) => ({ example, status: effectiveStatus(m, 'examples', example.example_id, 'draft') }));
      for (const e of examples) eById.set(e.example.example_id, e);
      const fPrompts = prompts
        .filter((p) => p.framework_id === f.id)
        .map((seed) => ({ seed, status: effectiveStatus(m, 'prompts', seed.id, seed.publication_status) }));
      for (const p of fPrompts) pById.set(p.seed.id, p);
      const fLessons = lessons
        .filter((l) => l.framework_id === f.id)
        .map((seed) => ({ seed, status: effectiveStatus(m, 'lessons', seed.id, seed.publication_status) }));
      for (const l of fLessons) lById.set(l.seed.id, l);
      fw.set(f.id, {
        config: f,
        status: effectiveStatus(m, 'frameworks', f.id, 'draft'),
        examples,
        prompts: fPrompts,
        lessons: fLessons,
        sourcePagesText: src ? src.pages.map((p) => `[page ${p.page}]\n${p.text_extracted}`).join('\n\n') : '',
      });
    }
    this.frameworks = fw;
    this.promptsById = pById;
    this.lessonsById = lById;
    this.examplesById = eById;
  }

  framework(id: string): CatalogFramework | null {
    return this.frameworks.get(id) ?? null;
  }

  /** Prompt visible to the viewer, or null (concealed) otherwise. */
  visiblePrompt(id: string, viewer: Viewer) {
    const p = this.promptsById.get(id);
    return p && visibleTo(viewer, p.status) ? p : null;
  }

  visibleLesson(id: string, viewer: Viewer) {
    const l = this.lessonsById.get(id);
    return l && visibleTo(viewer, l.status) ? l : null;
  }

  /** Frameworks with at least one visible prompt, in curriculum order. */
  visibleFrameworks(viewer: Viewer): CatalogFramework[] {
    return [...this.frameworks.values()]
      .filter((f) => visibleTo(viewer, f.status) || f.prompts.some((p) => visibleTo(viewer, p.status)))
      .sort((a, b) => a.config.order - b.config.order);
  }

  visiblePromptsFor(frameworkId: string, viewer: Viewer) {
    return (this.frameworks.get(frameworkId)?.prompts ?? []).filter((p) => visibleTo(viewer, p.status));
  }

  criteriaDto(f: FrameworkConfig, criterionIds?: readonly string[]): CriterionDto[] {
    const list = criterionIds ? f.criteria.filter((c) => criterionIds.includes(c.id)) : f.criteria;
    return list.map((c) => ({ id: c.id, label: c.label, origin: c.origin, definition: c.definition }));
  }

  promptDto(entry: { seed: PromptSeed; status: PublicationStatus }): PromptDto {
    const f = this.frameworks.get(entry.seed.framework_id)!.config;
    return {
      id: entry.seed.id,
      version: entry.seed.version,
      framework_id: entry.seed.framework_id,
      kind: entry.seed.kind,
      level: entry.seed.level,
      prompt: entry.seed.prompt,
      target_seconds: entry.seed.target_seconds,
      hard_limit_seconds: entry.seed.hard_limit_seconds,
      criteria: this.criteriaDto(f, entry.seed.criterion_ids),
      example_ids: entry.seed.example_ids,
      publication_status: entry.status,
    };
  }

  exampleDto(e: SourceExample): SourceExampleDto {
    return {
      example_id: e.example_id,
      text_verbatim: e.text_verbatim,
      teaching_use: e.teaching_use,
      editorial_note: e.editorial_note,
      source_filename: e.source_filename,
      source_pages: e.source_pages,
      text_sha256: e.text_sha256,
    };
  }

  outlineDto(f: CatalogFramework, viewer: Viewer): FrameworkOutlineDto {
    return {
      id: f.config.id,
      order: f.config.order,
      app_title: f.config.app_title,
      source_title: f.config.source_title,
      objective: f.config.objective,
      rubric_version: f.config.rubric_version,
      framework_number: frameworkNumber(f.config.id),
      publication_status: f.status,
      criteria: this.criteriaDto(f.config),
      lessons: f.lessons
        .filter((l) => visibleTo(viewer, l.status))
        .map((l) => ({ id: l.seed.id, version: l.seed.version, stage: l.seed.stage, title: l.seed.title, publication_status: l.status })),
    };
  }

  lessonDto(entry: { seed: LessonSeed; status: PublicationStatus }, viewer: Viewer): LessonDto {
    const f = this.frameworks.get(entry.seed.framework_id)!;
    const primary = this.examplesById.get(entry.seed.primary_example_id)!.example;
    const promptEntry = this.promptsById.get(entry.seed.prompt_id);
    const rec = recognitionByLesson.get(entry.seed.id);
    const recognition: RecognitionTaskDto | null =
      entry.seed.stage === 'notice' && rec
        ? {
            question: rec.question,
            options: rec.options,
            answer_id: rec.answer_id,
            rationale: rec.rationale,
            key_status: rec.key_status,
          }
        : null;
    return {
      id: entry.seed.id,
      version: entry.seed.version,
      framework_id: entry.seed.framework_id,
      framework_number: frameworkNumber(entry.seed.framework_id),
      app_title: f.config.app_title,
      stage: entry.seed.stage,
      title: entry.seed.title,
      explanation: entry.seed.explanation,
      source_statement_verbatim: f.config.source_statement_verbatim,
      source_statement_page: f.config.source_statement_page,
      source_file: f.config.source_file,
      primary_example: this.exampleDto(primary),
      examples: f.examples.map((e) => this.exampleDto(e.example)),
      criteria: this.criteriaDto(f.config),
      prompt: promptEntry && visibleTo(viewer, promptEntry.status) ? this.promptDto(promptEntry) : null,
      notice_task: entry.seed.notice_task,
      recognition,
      publication_status: entry.status,
    };
  }

  /** The single authored guest sample: first visible Notice lesson in curriculum order. */
  guestSampleLesson(): { seed: LessonSeed; status: PublicationStatus } | null {
    for (const f of this.visibleFrameworks({ editor: false })) {
      const l = f.lessons.find((x) => x.seed.stage === 'notice' && visibleTo({ editor: false }, x.status));
      if (l) return l;
    }
    return null;
  }
}

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Idempotently writes the catalog's versions into the content tables so
 * assignments, sessions and evaluations reference real (framework, version)
 * and (prompt, version) rows. Publication status is refreshed from the
 * manifest; content bytes of an existing version are never rewritten.
 */
export async function seedContentVersions(sql: Db, catalog: Catalog): Promise<void> {
  await sql.begin(async (tx) => {
    for (const f of catalog.frameworks.values()) {
      const src = sourcesByFramework.get(f.config.id);
      const contentHash = hashOf(f.config);
      await tx`
        insert into public.framework_versions (framework_id, version, framework_number, curriculum_order, app_title, source_title,
          source_file, source_pdf_sha256, source_statement_verbatim, source_statement_page, objective, criteria, example_ids,
          primary_example_id, content_hash, publication_status, published_at)
        values (${f.config.id}, ${f.config.rubric_version}, ${frameworkNumber(f.config.id)}, ${f.config.order}, ${f.config.app_title},
          ${f.config.source_title}, ${f.config.source_file}, ${src?.sha256_pdf ?? ''}, ${f.config.source_statement_verbatim},
          ${f.config.source_statement_page}, ${f.config.objective}, ${tx.json(f.config.criteria as never)}, ${f.config.example_ids},
          ${f.config.primary_example_id}, ${contentHash}, ${f.status}, ${f.status === 'published' ? new Date() : null})
        on conflict (framework_id, version) do update
          set publication_status = excluded.publication_status,
              published_at = coalesce(public.framework_versions.published_at, excluded.published_at)`;
      for (const e of f.examples) {
        await tx`
          insert into public.source_examples (example_id, version, framework_id, source_filename, source_pages, source_pdf_sha256,
            text_verbatim, text_sha256, teaching_use, editorial_note, publication_status)
          values (${e.example.example_id}, 1, ${e.example.framework_id}, ${e.example.source_filename}, ${e.example.source_pages},
            ${src?.sha256_pdf ?? ''}, ${e.example.text_verbatim}, ${e.example.text_sha256}, ${e.example.teaching_use},
            ${e.example.editorial_note}, ${e.status})
          on conflict (example_id, version) do update set publication_status = excluded.publication_status`;
      }
      for (const p of f.prompts) {
        await tx`
          insert into public.prompt_versions (prompt_id, version, framework_id, framework_version, kind, level, prompt, criterion_ids,
            example_ids, target_min_seconds, target_max_seconds, hard_limit_seconds, publication_status)
          values (${p.seed.id}, ${p.seed.version}, ${p.seed.framework_id}, ${f.config.rubric_version}, ${p.seed.kind}, ${p.seed.level},
            ${p.seed.prompt}, ${p.seed.criterion_ids}, ${p.seed.example_ids}, ${p.seed.target_seconds.min}, ${p.seed.target_seconds.max},
            ${p.seed.hard_limit_seconds}, ${p.status})
          on conflict (prompt_id, version) do update set publication_status = excluded.publication_status`;
      }
      for (const l of f.lessons) {
        const rec = recognitionByLesson.get(l.seed.id) ?? null;
        await tx`
          insert into public.lesson_versions (lesson_id, version, framework_id, framework_version, stage, title, explanation,
            primary_example_id, prompt_id, prompt_version, notice_task, recognition, recognition_key_status, publication_status)
          values (${l.seed.id}, ${l.seed.version}, ${l.seed.framework_id}, ${f.config.rubric_version}, ${l.seed.stage}, ${l.seed.title},
            ${l.seed.explanation}, ${l.seed.primary_example_id}, ${l.seed.prompt_id}, ${catalog.promptsById.get(l.seed.prompt_id)!.seed.version},
            ${l.seed.notice_task}, ${rec ? tx.json(rec as never) : null}, ${rec?.key_status ?? l.seed.recognition_answer_key_status}, ${l.status})
          on conflict (lesson_id, version) do update set publication_status = excluded.publication_status`;
      }
    }
  });
}
