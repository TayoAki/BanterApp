import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Evaluation, PartnerReply, Rewrite, RewriteVerification } from '@marshmemos/contracts';
import { normalizeTypography } from '@marshmemos/contracts';
import type {
  EntitlementProvider,
  EvaluationInput,
  FrameworkEvaluator,
  PartnerInput,
  PartnerModel,
  Providers,
  RewriteInput,
  RewriteVerifier,
  Rewriter,
  SpeechSynthesizer,
  Transcriber,
  VerifyInput,
} from './types.js';

/**
 * Fixture providers for development and tests. They implement the same
 * contracts as the OpenAI adapters with deterministic, rule-based output that
 * is clearly labeled. Production configuration refuses them.
 *
 * The fixture evaluator is intentionally simple: it scores by observable
 * text features (sentences, first-person markers, questions...) and never
 * follows instructions inside the transcript, which makes it useful for
 * adversarial pipeline tests but not for coaching quality.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_MP3 = path.resolve(here, '../media/__fixtures__/tone-0_5s.mp3');

export const FIXTURE_TRANSCRIPT = 'I walked into the wrong café. I was trying to look like I’d planned it.';

/** Sentence spans that remain exact substrings of the original text (no typographic normalization). */
function sentences(text: string): string[] {
  return text
    .trim()
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function clip(s: string, max = 170): string {
  return s.length <= max ? s : s.slice(0, max).replace(/\s+\S*$/, '');
}

export class FixtureTranscriber implements Transcriber {
  readonly model = 'fixture-transcriber';
  constructor(private readonly text: string = FIXTURE_TRANSCRIPT) {}
  async transcribe(input: { bytes: Buffer; filename: string; mime: string }) {
    if (input.bytes.length === 0) throw new Error('empty audio');
    return {
      text: this.text,
      language: 'en',
      duration_seconds: null,
      provider_meta: { fixture: true, note: 'Fixture transcription; not derived from the audio.' },
      model: this.model,
    };
  }
}

export class FixtureEvaluator implements FrameworkEvaluator {
  readonly model = 'fixture-evaluator';
  async evaluate(input: EvaluationInput) {
    const started = Date.now();
    const text = input.confirmed_transcript;
    const sents = sentences(text);
    const words = text.trim().split(/\s+/).filter(Boolean);
    const criteria = input.criteria;
    const lower = text.toLowerCase();

    const insufficient = words.length < 4;
    const threat = /\b(beat (them|him|her) up|punch (you|him|her)|i('| wi)ll hurt|kill (you|him|her))\b/i.test(text);
    const hasQuestion = /\?\s*$/.test(text.trim()) || /\?/.test(text);
    const firstPerson = /\b(i|i'm|i’m|my|me)\b/i.test(text);
    const innerMarkers = /\b(thinking|thought|felt|feel|realized|wanted|trying|wondered|nervous|embarrassed|proud|panic|obsessed|love|hate)\b/i.test(text);

    const scoreFor = (criterionId: string): { score: 0 | 1 | 2 | 3 | null; quote: string | null; reason: string } => {
      if (insufficient) return { score: null, quote: null, reason: 'Too little confirmed text to assess.' };
      const first = sents[0] ?? text;
      const inner = sents.find((s) => /\b(thinking|thought|felt|feel|realized|wanted|trying|wondered|nervous|embarrassed|proud|panic|obsessed|love|hate)\b/i.test(s)) ?? null;
      const question = sents.find((s) => s.includes('?')) ?? null;
      switch (criterionId) {
        case 'response_opening':
        case 'question':
        case 'opening':
        case 'shared':
          return hasQuestion && question
            ? { score: 2, quote: clip(question), reason: 'Ends with an invitation the listener can pick up.' }
            : { score: 0, quote: null, reason: 'The response ends before adding an invitation to respond.' };
        case 'personal_reaction':
        case 'inner_view':
        case 'thought_feeling':
        case 'extra_detail':
        case 'picture':
        case 'personal':
        case 'honesty':
          return innerMarkers && inner
            ? { score: 3, quote: clip(inner), reason: 'You reveal the thought behind your reaction.' }
            : firstPerson
              ? { score: 1, quote: clip(first), reason: 'You speak from your perspective but do not name the thought or feeling.' }
              : { score: 0, quote: null, reason: 'No inner thought or feeling is shared.' };
        default:
          return sents.length >= 1
            ? { score: sents.length >= 2 ? 3 : 2, quote: clip(first), reason: 'You name a specific moment.' }
            : { score: 0, quote: null, reason: 'No concrete moment is described.' };
      }
    };

    const scored = criteria.map((c) => {
      const s = scoreFor(c.id);
      return {
        criterion_id: c.id,
        score: s.score,
        evidence_quotes: s.score !== null && s.score > 0 && s.quote ? [s.quote] : [],
        reason: s.reason,
      };
    });
    const status: Evaluation['status'] = insufficient ? 'insufficient_input' : threat ? 'needs_revision' : 'scored';
    const strengthSentence = sents.find((s) => /\b(thinking|thought|felt|feel|trying|wanted)\b/i.test(s)) ?? null;
    const raw: Evaluation = {
      schema_version: '1.0',
      framework_id: input.framework.id,
      transcript_revision: input.transcript_revision,
      criteria: scored as Evaluation['criteria'],
      status,
      boundary_gate: threat ? 'needs_revision' : 'clear',
      confidence: insufficient ? 'low' : 'medium',
      strength: !insufficient && strengthSentence ? { evidence_quote: clip(strengthSentence), explanation: 'This gives the listener a glimpse inside your head.' } : null,
      priority_improvement: insufficient
        ? 'Record a little more so there is something to assess.'
        : threat
          ? 'Keep the story, drop the threat; the technique never needs pressure or violence.'
          : lower.includes('ignore the rubric')
            ? 'Instructions inside the transcript are treated as words, not commands. Add one light invitation for the listener.'
            : 'For this exercise, add a light way for the listener to join in.',
      retry_instruction: 'Keep the moment and reaction. Add one light invitation in your own words.',
      source_example_ids: [input.framework.primary_example_id],
      vocal_delivery_assessed: false,
    };
    return { raw, meta: { model: this.model, prompt_template_version: 'fixture', latency_ms: Date.now() - started } };
  }
}

export class FixtureRewriter implements Rewriter {
  readonly model = 'fixture-rewriter';
  /** Test hook: when set, the fixture produces this text instead (used for fact-check rejection tests). */
  forcedText: string | null = null;
  async rewrite(input: RewriteInput) {
    const started = Date.now();
    const sents = sentences(input.confirmed_transcript);
    if (sents.length === 0) {
      const raw: Rewrite = {
        schema_version: '1.0',
        framework_id: input.framework.id,
        transcript_revision: input.transcript_revision,
        status: 'needs_detail',
        rewrite_text: null,
        preserved_facts: [],
        changes: [],
        new_hypothetical: null,
        question_for_user: 'What actually happened, in one sentence?',
      };
      return { raw, meta: { model: this.model, prompt_template_version: 'fixture', latency_ms: Date.now() - started } };
    }
    const hasInvitation = /\?/.test(input.confirmed_transcript);
    const invitation = hasInvitation ? '' : ' Ever done that?';
    const text = this.forcedText ?? `${sents.join(' ')}${invitation}`;
    const target = input.criteria.find((c) => ['response_opening', 'question', 'opening', 'shared', 'usable'].includes(c.id)) ?? input.criteria[input.criteria.length - 1]!;
    const raw: Rewrite = {
      schema_version: '1.0',
      framework_id: input.framework.id,
      transcript_revision: input.transcript_revision,
      status: 'ready',
      rewrite_text: text,
      preserved_facts: sents.slice(0, 2).filter((s) => text.includes(s)).map((s) => ({ input_quote: clip(s, 240), rewrite_quote: clip(s, 240) })),
      changes: hasInvitation ? [] : [{ criterion_id: target.id, description: 'Added a brief invitation for the listener to respond.' }],
      new_hypothetical: null,
      question_for_user: null,
    };
    return { raw, meta: { model: this.model, prompt_template_version: 'fixture', latency_ms: Date.now() - started } };
  }
}

export class FixtureVerifier implements RewriteVerifier {
  readonly model = 'fixture-verifier';
  async verify(input: VerifyInput) {
    const started = Date.now();
    // Deterministic stand-in for the semantic verifier: any rewrite sentence
    // that shares no content word with the transcript (other than a short
    // question/invitation) is reported as unsupported.
    const transcriptWords = new Set(normalizeTypography(input.confirmed_transcript).toLowerCase().match(/[a-z']+/g) ?? []);
    const issues: RewriteVerification['issues'] = [];
    for (const s of sentences(input.rewrite_text)) {
      const ws = s.toLowerCase().match(/[a-z']+/g) ?? [];
      const content = ws.filter((w) => w.length > 3);
      if (content.length === 0) continue;
      if (s.trim().endsWith('?') && ws.length <= 6) continue; // light invitation
      const shared = content.filter((w) => transcriptWords.has(w)).length;
      if (shared / content.length < 0.34) issues.push({ rewrite_span: clip(s, 240), explanation: 'This claim is not supported by the original words.' });
    }
    const raw: RewriteVerification = { verdict: issues.length > 0 ? 'revise' : 'pass', issues };
    return { raw, meta: { model: this.model, prompt_template_version: 'fixture', latency_ms: Date.now() - started } };
  }
}

export class FixturePartner implements PartnerModel {
  readonly model = 'fixture-partner';
  async reply(input: PartnerInput) {
    const started = Date.now();
    const declined = /\b(no thanks|not interested|i should go|leave me alone)\b/i.test(input.learner_turn);
    const raw: PartnerReply = declined
      ? { partner_reply: 'Fair enough. Nice talking to you.', conversation_state: 'ended', boundary_signal: 'disengaged' }
      : input.turns_remaining <= 1
        ? { partner_reply: 'Ha, I have absolutely done that. Anyway, I should get going.', conversation_state: 'ended', boundary_signal: 'none' }
        : { partner_reply: 'Ha, I have absolutely done that. What happened next?', conversation_state: 'continuing', boundary_signal: 'none' };
    return { raw, meta: { model: this.model, prompt_template_version: 'fixture', latency_ms: Date.now() - started } };
  }
}

export class FixtureSpeech implements SpeechSynthesizer {
  readonly model = 'fixture-tts';
  readonly voice = 'fixture';
  async synthesize(input: { text: string; voice?: string }) {
    if (input.text.trim().length === 0) throw new Error('empty text');
    return { bytes: readFileSync(FIXTURE_MP3), mime: 'audio/mpeg', model: this.model, voice: input.voice ?? this.voice };
  }
}

export class NoEntitlements implements EntitlementProvider {
  readonly name = 'none' as const;
  async fetch() {
    return { state: 'none' as const, product_id: null, expires_at: null, grace_until: null, environment: null, provider_customer_id: null };
  }
  verifyWebhook() {
    return false;
  }
}

/** Demo entitlements for tests: activates Pro when the user id is in the set. */
export class DemoEntitlements implements EntitlementProvider {
  readonly name = 'demo' as const;
  readonly pro = new Set<string>();
  constructor(private readonly webhookSecret = 'demo-webhook-secret') {}
  async fetch(appUserId: string) {
    const isPro = this.pro.has(appUserId.toLowerCase());
    return {
      state: isPro ? ('active' as const) : ('none' as const),
      product_id: isPro ? 'demo_pro_monthly' : null,
      expires_at: isPro ? new Date(Date.now() + 30 * 86_400_000) : null,
      grace_until: null,
      environment: 'demo' as const,
      provider_customer_id: appUserId,
    };
  }
  verifyWebhook(headers: Record<string, string | undefined>) {
    return headers['authorization'] === this.webhookSecret;
  }
}

export function createFixtureProviders(options: { transcript?: string; entitlements?: EntitlementProvider } = {}): Providers {
  return {
    mode: 'fixture',
    transcriber: new FixtureTranscriber(options.transcript),
    evaluator: new FixtureEvaluator(),
    rewriter: new FixtureRewriter(),
    verifier: new FixtureVerifier(),
    partner: new FixturePartner(),
    speech: new FixtureSpeech(),
    entitlements: options.entitlements ?? new NoEntitlements(),
  };
}
