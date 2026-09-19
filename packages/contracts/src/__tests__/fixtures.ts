import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Evaluation, FrameworkConfig, Rewrite, SourceExample } from '../types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const HANDOFF = path.resolve(here, '../../../../handoff');

export const frameworks = JSON.parse(readFileSync(path.join(HANDOFF, 'content/frameworks.json'), 'utf8')) as FrameworkConfig[];
export const corpus = JSON.parse(readFileSync(path.join(HANDOFF, 'content/source-corpus.json'), 'utf8')) as {
  examples: SourceExample[];
};
export const fixtureAttempt = JSON.parse(readFileSync(path.join(HANDOFF, 'fixtures/attempt.json'), 'utf8')) as {
  framework_id: 'F02';
  prompt_id: string;
  transcript_revision: number;
  confirmed_transcript: string;
};
export const fixtureEvaluation = JSON.parse(readFileSync(path.join(HANDOFF, 'fixtures/evaluation.json'), 'utf8')) as Evaluation;
export const fixtureRewrite = JSON.parse(readFileSync(path.join(HANDOFF, 'fixtures/rewrite.json'), 'utf8')) as Rewrite;

export const F02 = frameworks.find((f) => f.id === 'F02')!;
export const F02_CRITERIA = F02.criteria.map((c) => c.id);
export const F02_EXAMPLES = corpus.examples.filter((e) => e.framework_id === 'F02');

export const f02Context = {
  framework: F02,
  assignedCriterionIds: F02_CRITERIA,
  expectedRevision: 1,
  confirmedTranscript: fixtureAttempt.confirmed_transcript,
  allowedSourceExampleIds: F02.example_ids,
};

export function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
