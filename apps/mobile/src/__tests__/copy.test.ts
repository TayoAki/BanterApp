import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.resolve(here, '..', rel), 'utf8');

/** Exact production copy from handoff/docs/05-design.md must appear verbatim. */
describe('exact production copy', () => {
  it('Today', () => {
    const s = read('app/(tabs)/today.tsx');
    for (const c of ['What’s your story today?', 'Start speaking', 'Today’s framework']) expect(s).toContain(c);
  });
  it('Recording', () => {
    const s = read('app/practice/[session]/record.tsx');
    for (const c of ['Go on. We’re listening.', 'Finish recording', 'Recording', '60 second target · 90 second limit', 'Only records while this screen is open.', 'Discard recording']) expect(s).toContain(c);
    expect(s).toContain('Microphone access is off. You can enable it in Settings or type your practice.');
    expect(s).toContain('Open settings');
    expect(s).toContain('Type instead');
  });
  it('Transcript', () => {
    const s = read('app/attempt/[id]/transcript.tsx');
    for (const c of ['Did we hear you right?', 'Edit transcript', 'Your feedback uses the words you confirm.', 'Get my feedback', 'Record again']) expect(s).toContain(c);
    expect(s).toContain('We couldn’t get a clear transcript. Try another take or type what you said.');
    expect(s).toContain('Your words are saved. Feedback couldn’t finish yet.');
    expect(s).toContain('We’re still working—come back shortly');
  });
  it('Review recording', () => {
    expect(read('app/practice/[session]/review-recording.tsx')).toContain('Your recording is saved on this device. Try sending it again.');
  });
  it('Feedback', () => {
    const s = read('app/attempt/[id]/feedback.tsx');
    for (const c of ['Practice fit · Framework', 'Source criteria:', 'Exercise target:', 'What went well', 'One thing to work on', 'View suggested rewrite', 'This feedback seems wrong', 'We need a little more context to assess this.']) expect(s).toContain(c);
    expect(s).not.toContain('Framework fit');
    expect(s).not.toContain('Hear a stronger version');
  });
  it('Rewrite', () => {
    const s = read('app/rewrite/[id].tsx');
    for (const c of ['Still your story. A little more spark.', 'Suggested rewrite', 'Listen', 'AI-generated voice', 'What changed', 'You don’t need to memorize it.', 'Try it in your own words', 'Audio is unavailable right now.']) expect(s).toContain(c);
  });
  it('Progress', () => {
    const s = read('app/(tabs)/progress.tsx');
    for (const c of ['Small reps. Real progress.', 'Guided retry · mastery still developing']) expect(s).toContain(c);
  });
  it('Reminder copy and microphone permission text', () => {
    expect(read('lib/notifications.ts')).toContain('Your marshmemos practice is ready.');
    expect(read('../app.json')).toContain('marshmemos uses your microphone to record practice you choose to send for feedback.');
  });
});
