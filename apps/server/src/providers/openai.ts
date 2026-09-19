import OpenAI, { toFile } from 'openai';
import { SCHEMAS, toProviderStrictSchema } from '@marshmemos/contracts';
import type { ServerConfig } from '../config.js';
import { DATA_ENVELOPE_NOTE, PROMPT_TEMPLATES } from './prompts.js';
import {
  ProviderError,
  type EvaluationInput,
  type FrameworkEvaluator,
  type PartnerInput,
  type PartnerModel,
  type RewriteInput,
  type RewriteVerifier,
  type Rewriter,
  type SpeechSynthesizer,
  type StructuredResult,
  type Transcriber,
  type VerifyInput,
} from './types.js';

/**
 * OpenAI adapters. Model IDs come from server configuration. Structured
 * calls use the Responses API with a strict JSON schema translated from the
 * local authoritative contracts; the pipeline still validates every field.
 * Refusals, incomplete outputs and unparseable text are distinct errors,
 * never treated as evaluations.
 */

function classify(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const anyErr = err as { status?: number; code?: string; message?: string; headers?: Record<string, string> | Headers; name?: string };
  const message = anyErr?.message ?? String(err);
  if (anyErr?.name === 'AbortError' || /timed? ?out/i.test(message)) return new ProviderError('timeout', `Provider timeout: ${message}`, { billingUncertain: true });
  const status = anyErr?.status;
  if (status === 429) {
    let retryAfterMs: number | null = null;
    const h = anyErr.headers;
    const ra = h instanceof Headers ? h.get('retry-after') : h?.['retry-after'];
    if (ra && Number.isFinite(Number(ra))) retryAfterMs = Number(ra) * 1000;
    return new ProviderError('rate_limited', 'Provider rate limit.', { retryAfterMs });
  }
  if (status === 401 || status === 403) return new ProviderError('denied', 'Provider access denied.');
  if (status === 400 || status === 404 || status === 413 || status === 415 || status === 422) return new ProviderError('bad_input', `Provider rejected input (${status}).`);
  if (status !== undefined && status >= 500) return new ProviderError('transient', `Provider error ${status}.`, { billingUncertain: true });
  if (/ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network/i.test(message)) return new ProviderError('transient', `Network error: ${message}`, { billingUncertain: true });
  return new ProviderError('transient', message, { billingUncertain: true });
}

export function createOpenAIClient(config: ServerConfig): OpenAI {
  return new OpenAI({
    apiKey: config.AI_API_KEY ?? '',
    ...(config.AI_BASE_URL ? { baseURL: config.AI_BASE_URL } : {}),
    maxRetries: 0, // retries are the worker's job, with recorded budgets
  });
}

export class OpenAITranscriber implements Transcriber {
  constructor(
    private readonly client: OpenAI,
    readonly model: string,
  ) {}
  async transcribe(input: { bytes: Buffer; filename: string; mime: string; languageHint?: string }, opts: { timeoutMs: number }) {
    try {
      const file = await toFile(input.bytes, input.filename, { type: input.mime });
      // No framework examples, ideal answers, or grading text: literal transcription only.
      const useLogprobs = /gpt-4o(-mini)?-transcribe/.test(this.model);
      const res = await this.client.audio.transcriptions.create(
        {
          file,
          model: this.model,
          response_format: 'json',
          ...(input.languageHint ? { language: input.languageHint } : {}),
          ...(useLogprobs ? { include: ['logprobs'] } : {}),
        },
        { timeout: opts.timeoutMs },
      );
      const logprobs = Array.isArray(res.logprobs) ? res.logprobs : null;
      const avgLogprob = logprobs && logprobs.length > 0 ? logprobs.reduce((a, l) => a + (typeof l.logprob === 'number' ? l.logprob : 0), 0) / logprobs.length : null;
      return {
        text: res.text ?? '',
        language: input.languageHint ?? null,
        duration_seconds: null,
        provider_meta: {
          model: this.model,
          ...(avgLogprob !== null ? { avg_token_logprob: avgLogprob, token_count: logprobs!.length } : {}),
          usage: (res as { usage?: unknown }).usage ?? null,
        },
        model: this.model,
      };
    } catch (err) {
      throw classify(err);
    }
  }
}

async function structuredCall(
  client: OpenAI,
  args: { model: string; instructions: string; data: unknown; schemaName: keyof typeof SCHEMAS; timeoutMs: number; templateVersion: string; repairHint?: string | undefined },
): Promise<StructuredResult> {
  const started = Date.now();
  const schema = toProviderStrictSchema(SCHEMAS[args.schemaName] as Record<string, unknown>);
  const instructions = [args.instructions, DATA_ENVELOPE_NOTE, args.repairHint ? `Repair note: ${args.repairHint}` : null].filter(Boolean).join('\n\n');
  let res: Awaited<ReturnType<OpenAI['responses']['create']>>;
  try {
    res = await client.responses.create(
      {
        model: args.model,
        instructions,
        input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify(args.data) }] }],
        text: { format: { type: 'json_schema', name: args.schemaName, schema, strict: true } },
        store: false,
        max_output_tokens: 2000,
      },
      { timeout: args.timeoutMs },
    );
  } catch (err) {
    throw classify(err);
  }
  const response = res as OpenAI.Responses.Response;
  if (response.status === 'incomplete') {
    throw new ProviderError('incomplete', `Model output incomplete (${response.incomplete_details?.reason ?? 'unknown'}).`);
  }
  for (const item of response.output ?? []) {
    if (item.type === 'message') {
      for (const part of item.content) {
        if (part.type === 'refusal') throw new ProviderError('refusal', `Model refused: ${part.refusal.slice(0, 200)}`);
      }
    }
  }
  const text = response.output_text;
  if (!text || text.trim().length === 0) throw new ProviderError('malformed_output', 'Model returned no text output.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderError('malformed_output', 'Model output was not valid JSON.');
  }
  return {
    raw: parsed,
    meta: {
      model: response.model ?? args.model,
      prompt_template_version: args.templateVersion,
      ...(response.usage ? { usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens, total_tokens: response.usage.total_tokens } } : {}),
      latency_ms: Date.now() - started,
    },
  };
}

function examplesForModel(examples: EvaluationInput['examples']) {
  return examples.map((e) => ({
    example_id: e.example_id,
    teaching_use: e.teaching_use,
    editorial_note: e.editorial_note,
    text_verbatim: e.text_verbatim,
  }));
}

function boundedSourceContext(text: string, max = 12_000): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[...source context truncated for length; examples are complete]`;
}

export class OpenAIEvaluator implements FrameworkEvaluator {
  constructor(
    private readonly client: OpenAI,
    readonly model: string,
    private readonly templateVersion: string,
  ) {}
  async evaluate(input: EvaluationInput, opts: { timeoutMs: number; repairHint?: string }) {
    const data = {
      framework: { id: input.framework.id, source_title: input.framework.source_title, source_statement_verbatim: input.framework.source_statement_verbatim, objective: input.framework.objective },
      rubric_version: input.rubric_version,
      criteria: input.criteria.map((c) => ({ id: c.id, label: c.label, origin: c.origin, definition: c.definition, anchors: c.anchors })),
      examples: examplesForModel(input.examples),
      source_context: boundedSourceContext(input.source_context),
      prompt: input.prompt,
      confirmed_transcript: input.confirmed_transcript,
      transcript_revision: input.transcript_revision,
      input_mode: input.input_mode,
      scenario_context: input.scenario_context,
      is_guided_retry: input.is_guided_retry,
      ...(input.partner_turns ? { partner_turns: input.partner_turns } : {}),
    };
    return structuredCall(this.client, {
      model: this.model,
      instructions: PROMPT_TEMPLATES.evaluate,
      data,
      schemaName: 'evaluation',
      timeoutMs: opts.timeoutMs,
      templateVersion: this.templateVersion,
      repairHint: opts.repairHint,
    });
  }
}

export class OpenAIRewriter implements Rewriter {
  constructor(
    private readonly client: OpenAI,
    readonly model: string,
    private readonly templateVersion: string,
  ) {}
  async rewrite(input: RewriteInput, opts: { timeoutMs: number; repairHint?: string }) {
    const data = {
      framework: { id: input.framework.id, source_statement_verbatim: input.framework.source_statement_verbatim, objective: input.framework.objective },
      rubric_version: input.rubric_version,
      criteria: input.criteria.map((c) => ({ id: c.id, label: c.label, origin: c.origin, definition: c.definition })),
      examples: examplesForModel(input.examples),
      prompt: input.prompt,
      confirmed_transcript: input.confirmed_transcript,
      transcript_revision: input.transcript_revision,
      approved_evaluation: input.evaluation,
      fictional: input.fictional,
      scenario_context: input.scenario_context,
    };
    return structuredCall(this.client, {
      model: this.model,
      instructions: PROMPT_TEMPLATES.rewrite,
      data,
      schemaName: 'rewrite',
      timeoutMs: opts.timeoutMs,
      templateVersion: this.templateVersion,
      repairHint: opts.repairHint,
    });
  }
}

export class OpenAIVerifier implements RewriteVerifier {
  constructor(
    private readonly client: OpenAI,
    readonly model: string,
    private readonly templateVersion: string,
  ) {}
  async verify(input: VerifyInput, opts: { timeoutMs: number }) {
    // Only the original, the rewrite, the task and criteria: no rewriter self-justification.
    const data = {
      original_transcript: input.confirmed_transcript,
      proposed_rewrite: input.rewrite_text,
      task: input.task,
      criteria: input.criteria.map((c) => ({ id: c.id, label: c.label, definition: c.definition })),
      fictional: input.fictional,
      scenario_context: input.scenario_context,
    };
    return structuredCall(this.client, {
      model: this.model,
      instructions: PROMPT_TEMPLATES.verify,
      data,
      schemaName: 'rewrite_verification',
      timeoutMs: opts.timeoutMs,
      templateVersion: this.templateVersion,
    });
  }
}

export class OpenAIPartner implements PartnerModel {
  constructor(
    private readonly client: OpenAI,
    readonly model: string,
    private readonly templateVersion: string,
  ) {}
  async reply(input: PartnerInput, opts: { timeoutMs: number }) {
    return structuredCall(this.client, {
      model: this.model,
      instructions: PROMPT_TEMPLATES.roleplay,
      data: input,
      schemaName: 'partner',
      timeoutMs: opts.timeoutMs,
      templateVersion: this.templateVersion,
    });
  }
}

export class OpenAISpeech implements SpeechSynthesizer {
  constructor(
    private readonly client: OpenAI,
    readonly model: string,
    readonly voice: string,
  ) {}
  async synthesize(input: { text: string; voice?: string }, opts: { timeoutMs: number }) {
    try {
      const res = await this.client.audio.speech.create(
        { model: this.model, voice: input.voice ?? this.voice, input: input.text, response_format: 'mp3' },
        { timeout: opts.timeoutMs },
      );
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0) throw new ProviderError('malformed_output', 'Empty speech response.');
      return { bytes, mime: 'audio/mpeg', model: this.model, voice: input.voice ?? this.voice };
    } catch (err) {
      throw classify(err);
    }
  }
}
