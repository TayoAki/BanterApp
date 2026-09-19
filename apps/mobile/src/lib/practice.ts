import type { AttemptDto, SessionDto, SessionMode } from '@marshmemos/contracts/api';
import { api } from './api';
import { stableClientKey } from './keys';
import { track } from './telemetry';

/** Starts (or resumes) a session with a stable client key per target so retries never double-reserve. */
export async function startSession(input: { assignmentId?: string; promptId?: string; promptVersion?: number; mode: SessionMode }): Promise<SessionDto> {
  const target = input.assignmentId ? `assignment:${input.assignmentId}` : `prompt:${input.promptId}:${input.promptVersion}:${input.mode}`;
  const client_key = await stableClientKey(`session:${target}`);
  const session = await api.createSession({
    client_key,
    mode: input.mode,
    ...(input.assignmentId ? { assignment_id: input.assignmentId } : {}),
    ...(input.promptId ? { prompt_id: input.promptId, prompt_version: input.promptVersion ?? 1 } : {}),
  });
  if (session.created) track('practice_started', { framework_id: session.framework_id, mode: session.mode });
  return session;
}

/** Where to send the learner for an attempt in its current stage. */
export function routeForAttempt(attempt: Pick<AttemptDto, 'attempt_id' | 'session_id' | 'stage' | 'evaluation_id'>): string {
  switch (attempt.stage) {
    case 'created':
    case 'uploading':
      return `/practice/${attempt.session_id}/record`;
    case 'uploaded':
    case 'transcribing':
    case 'transcript_review':
    case 'evaluating':
      return `/attempt/${attempt.attempt_id}/transcript`;
    case 'feedback':
      return `/attempt/${attempt.attempt_id}/feedback`;
    default:
      return `/practice/${attempt.session_id}/record`;
  }
}

export const STAGE_LABEL: Record<AttemptDto['stage'], string> = {
  created: 'Ready to record',
  uploading: 'Upload pending',
  uploaded: 'Upload pending',
  transcribing: 'Transcribing',
  transcript_review: 'Transcript ready to check',
  evaluating: 'Feedback in progress',
  feedback: 'Feedback ready',
  failed: 'Needs attention',
  deleted: 'Deleted',
};
