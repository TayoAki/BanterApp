/**
 * Authored Notice-stage recognition tasks (draft).
 *
 * Authoring rules (handoff/prompts/author-lesson.md): options quote exact
 * spans of the lesson's primary source example; the key and rationale are
 * editorial; a critique example is analyzed, never presented as a model
 * answer; there is no claim that only one social reply is acceptable, only
 * that one span best shows the named move.
 *
 * Status: authored by the builder, pending curriculum review. Served only
 * where the lesson itself is visible; the key_status is shown to editors.
 */
export interface RecognitionTask {
  lesson_id: string;
  criterion_id: string;
  question: string;
  options: Array<{ id: string; text: string }>;
  answer_id: string;
  /** Editorial explanation of why the keyed span shows the move. */
  rationale: string;
  /** Editorial note for examples whose wording is not to be imitated. */
  critique_note: string | null;
  key_status: 'authored_draft_pending_review';
  authored_by: 'builder';
}

export const recognitionTasks: RecognitionTask[] = [
  {
    lesson_id: 'F01-L01',
    criterion_id: 'inner_view',
    question: 'Which part reveals the speaker’s inner reaction rather than a status fact?',
    options: [
      { id: 'a', text: 'he tells me I’m getting a raise and promotion' },
      { id: 'b', text: 'I’m like a giddy little school girl waiting to sneak off somewhere I can jump in the air and do a massive fist pump' },
      { id: 'c', text: 'My boss calls me into his office' },
    ],
    answer_id: 'b',
    rationale:
      'The raise is the status fact and the office is the setup. The giddy fist-pump image is the thought and feeling that let the listener see the speaker’s personality, which is the move F01 teaches.',
    critique_note: 'The violent imagery about the boss is a source detail, not the skill being rewarded.',
    key_status: 'authored_draft_pending_review',
    authored_by: 'builder',
  },
  {
    lesson_id: 'F02-L01',
    criterion_id: 'personal_reaction',
    question: 'Which line reveals the speaker’s inner dilemma about an ordinary moment?',
    options: [
      { id: 'a', text: 'I’m walking today in a pair of flip flops' },
      { id: 'b', text: 'I really want to look around and see if anyone saw, but I know that just makes it worse' },
      { id: 'c', text: 'So what’s the right move there?' },
    ],
    answer_id: 'b',
    rationale:
      'The flip flops are the mundane event and the final question is the invitation to respond. The middle line is the personal reaction that makes an ordinary stumble worth talking about.',
    critique_note: null,
    key_status: 'authored_draft_pending_review',
    authored_by: 'builder',
  },
  {
    lesson_id: 'F05-L01',
    criterion_id: 'anecdote',
    question: 'Which part answers “why English?” with a small incident instead of a list of reasons?',
    options: [
      { id: 'a', text: 'I chose English, I don’t even know why' },
      { id: 'b', text: 'I was stoned watching Reality Bites, and Ethan Hawke’s character seemed all cool and philosophical' },
      { id: 'c', text: 'What about you? Why did you choose to major in finance..' },
    ],
    answer_id: 'b',
    rationale:
      'The first option is the bare answer and the last is the hand-off question. The middle option is the specific incident that shows how the choice actually happened.',
    critique_note: 'Drug use and profanity are details of the source, not a required style for your own anecdote.',
    key_status: 'authored_draft_pending_review',
    authored_by: 'builder',
  },
  {
    lesson_id: 'F06-L01',
    criterion_id: 'action',
    question: 'Which line shows people doing something concrete rather than naming a quality?',
    options: [
      { id: 'a', text: 'That’s awesome' },
      { id: 'b', text: 'the homeless guy gets the biggest shit eating grin on his face, and runs up to the guy' },
      { id: 'c', text: 'That inspires me to get off my ass' },
    ],
    answer_id: 'b',
    rationale:
      '“That’s awesome” is a label and the last line is a reaction statement. The middle line describes actions the listener can picture, which is what moves the scene forward.',
    critique_note: 'The assumption that the man was “about to attack” is examined in this lesson, not imitated.',
    key_status: 'authored_draft_pending_review',
    authored_by: 'builder',
  },
  {
    lesson_id: 'F03-L01',
    criterion_id: 'shared',
    question: 'Which part offers an imagined moment both people can take part in?',
    options: [
      { id: 'a', text: 'I have a horrible voice' },
      { id: 'b', text: 'if we recorded a song with the both us singing' },
      { id: 'c', text: 'maybe a monkey playing the Tambourine' },
    ],
    answer_id: 'b',
    rationale:
      'The first option includes the speaker (their own admission). The monkey is a playful detail inside the scene. “If we recorded a song” is the shared frame that puts both people in the picture without assuming agreement.',
    critique_note: null,
    key_status: 'authored_draft_pending_review',
    authored_by: 'builder',
  },
  {
    lesson_id: 'F10-L01',
    criterion_id: 'own_answer',
    question: 'Which part gives the speaker’s own answer before the question is asked?',
    options: [
      { id: 'a', text: 'Hey I want to learn to play chess' },
      { id: 'b', text: 'What do you want to do that you have never done?' },
      { id: 'c', text: 'just like destroying nerds' },
    ],
    answer_id: 'a',
    rationale:
      'Answering first tells the listener what kind of answer is welcome. The question comes after; the joke about nerds is a stage flourish, not the move.',
    critique_note: 'Mocking a group is not required to telegraph your answer.',
    key_status: 'authored_draft_pending_review',
    authored_by: 'builder',
  },
  {
    lesson_id: 'F08-L01',
    criterion_id: 'honesty',
    question: 'Which line shares a genuine feeling comfortably, without blaming anyone?',
    options: [
      { id: 'a', text: 'I turned 37 last week' },
      { id: 'b', text: 'I started having like a mid life crisis panic attack' },
      { id: 'c', text: 'So what’s on your bucket list?' },
    ],
    answer_id: 'b',
    rationale:
      'The birthday is a fact and the bucket-list question turns outward. The middle line names the vulnerable feeling directly and owns it, which is the honest disclosure F08 teaches.',
    critique_note: null,
    key_status: 'authored_draft_pending_review',
    authored_by: 'builder',
  },
  {
    lesson_id: 'F07-L01',
    criterion_id: 'entry',
    question: 'Which part starts near the interesting moment instead of at the start of the day?',
    options: [
      { id: 'a', text: 'So, I’m trying to avoid this friend that keeps calling me' },
      { id: 'b', text: 'so I’m driving over here' },
      { id: 'c', text: 'kind of guy you know doesn’t have your back' },
    ],
    answer_id: 'a',
    rationale:
      'The story opens mid-situation. Driving over is background, and the description of the friend is context added only as needed.',
    critique_note: 'Gossip and immediate intensity may not fit a first conversation; the move to notice is the entry point, not the topic.',
    key_status: 'authored_draft_pending_review',
    authored_by: 'builder',
  },
  {
    lesson_id: 'F11-L01',
    criterion_id: 'unexpected',
    question: 'Which line opens a fresh thread with an unexpected personal statement?',
    options: [
      { id: 'a', text: 'I’m obsessed with corn dogs' },
      { id: 'b', text: 'if someone tells me a diner has a good corn dog, I’ll like do a road trip' },
      { id: 'c', text: 'I don’t take you as the type of girl who likes corn dogs' },
    ],
    answer_id: 'a',
    rationale:
      'The first line breaks the interview pattern with an oddly specific enthusiasm. The road-trip detail supports it, and the last line makes an assumption about the listener rather than revealing the speaker.',
    critique_note: 'The final sentence assumes something about the listener without grounds; it is not part of the move.',
    key_status: 'authored_draft_pending_review',
    authored_by: 'builder',
  },
  {
    lesson_id: 'F12-L01',
    criterion_id: 'initiative',
    question:
      'This example is preserved for critique. Which part shows the mechanism of offering a personal thread first, as opposed to the wording that makes it unsuitable to imitate?',
    options: [
      { id: 'a', text: 'I went out on a date with an old woman once' },
      { id: 'b', text: 'I hate old people, lets go find some old people and people beat them up' },
      { id: 'c', text: 'I kind of feel like I have to kiss her, because you know she paid for dinner' },
    ],
    answer_id: 'a',
    rationale:
      'Offering a personal story gives the other person something to respond to; that is the F12 mechanism. The other two spans are why this wording must not be imitated: violent age-based contempt and an implied obligation to kiss are not rapport skills.',
    critique_note:
      'Quoted for analysis, not endorsement. Learners are never asked to imitate threats, contempt, or pressure.',
    key_status: 'authored_draft_pending_review',
    authored_by: 'builder',
  },
];

export const recognitionByLesson: ReadonlyMap<string, RecognitionTask> = new Map(recognitionTasks.map((t) => [t.lesson_id, t]));
