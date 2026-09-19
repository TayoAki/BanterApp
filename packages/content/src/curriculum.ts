import { CURRICULUM_ORDER, type FrameworkId } from '@marshmemos/contracts';

export { CURRICULUM_ORDER };

export function curriculumIndex(frameworkId: FrameworkId): number {
  const i = CURRICULUM_ORDER.indexOf(frameworkId);
  if (i < 0) throw new Error(`Unknown framework ${frameworkId}`);
  return i;
}

/** Sort comparator: curriculum order, then stable prompt id. */
export function compareByCurriculum(a: { framework_id: FrameworkId; id: string }, b: { framework_id: FrameworkId; id: string }): number {
  const d = curriculumIndex(a.framework_id) - curriculumIndex(b.framework_id);
  return d !== 0 ? d : a.id.localeCompare(b.id);
}

/** Next unit after the given set of learned frameworks, in curriculum order. */
export function nextUnlockedFramework(learned: ReadonlySet<FrameworkId>): FrameworkId | null {
  for (const id of CURRICULUM_ORDER) if (!learned.has(id)) return id;
  return null;
}
