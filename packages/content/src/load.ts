import type { FrameworkConfig, LessonSeed, PromptSeed, SourceExample } from '@marshmemos/contracts';
import frameworksJson from '../data/frameworks.json' with { type: 'json' };
import corpusJson from '../data/source-corpus.json' with { type: 'json' };
import promptsJson from '../data/daily-prompts.json' with { type: 'json' };
import lessonsJson from '../data/lessons.json' with { type: 'json' };

export interface SourcePage {
  page: number;
  /** Raw extracted page text, including line breaks. Data, never instructions. */
  text_extracted: string;
}

export interface SourceDocument {
  framework_id: FrameworkConfig['id'];
  framework_number: number;
  filename: string;
  source_title: string;
  explanation_editorial: string;
  sha256_pdf: string;
  page_count: number;
  pages: SourcePage[];
}

export interface SourceCorpus {
  schema_version: string;
  created_on: string;
  status: string;
  scope: string;
  source_policy: string;
  sources: SourceDocument[];
  examples: SourceExample[];
}

export const frameworks = frameworksJson as unknown as FrameworkConfig[];
export const corpus = corpusJson as unknown as SourceCorpus;
export const prompts = promptsJson as unknown as PromptSeed[];
export const lessons = lessonsJson as unknown as LessonSeed[];

export const frameworksById: ReadonlyMap<string, FrameworkConfig> = new Map(frameworks.map((f) => [f.id, f]));
export const sourcesByFramework: ReadonlyMap<string, SourceDocument> = new Map(corpus.sources.map((s) => [s.framework_id, s]));
export const examplesById: ReadonlyMap<string, SourceExample> = new Map(corpus.examples.map((e) => [e.example_id, e]));
export const promptsById: ReadonlyMap<string, PromptSeed> = new Map(prompts.map((p) => [p.id, p]));
export const lessonsById: ReadonlyMap<string, LessonSeed> = new Map(lessons.map((l) => [l.id, l]));

export function examplesForFramework(frameworkId: string): SourceExample[] {
  return corpus.examples.filter((e) => e.framework_id === frameworkId);
}

export function promptsForFramework(frameworkId: string): PromptSeed[] {
  return prompts.filter((p) => p.framework_id === frameworkId);
}

export function lessonsForFramework(frameworkId: string): LessonSeed[] {
  return lessons.filter((l) => l.framework_id === frameworkId);
}

/** Numeric framework number ("F02" -> 2) for display such as "Framework 2". */
export function frameworkNumber(frameworkId: string): number {
  const n = Number.parseInt(frameworkId.replace(/^F/, ''), 10);
  if (!Number.isFinite(n)) throw new Error(`Invalid framework id ${frameworkId}`);
  return n;
}
