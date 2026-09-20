import OpenAI, { toFile } from 'openai';
import { SCHEMAS, toProviderStrictSchema } from '@marshmemos/contracts';
import type { ServerConfig } from '../config.js';
import { classifyProviderError as classify } from './classify.js';
import { DATA_ENVELOPE_NOTE, PROMPT_TEMPLATES } from './prompts.js';
import {
  ProviderError,
  type EvaluationInput,
  type FrameworkEvaluator,
  type PartnerInput,
  type PartnerModel,
  type RepairRequest,
  type RewriteInput,
  type RewriteVerifier,
  type Rewriter,
  type SpeechSynthesizer,
  type StructuredResult,
  type Transcriber,
  type VerifyInput,
} from './types.js';

/**
 * OpenAI-compatible adapters. Model IDs come from server configuration.
 * Structured calls use either the Responses API (OpenAI) or Chat Completions
 * with `response_format: json_schema` (OpenRouter and other compatible
 * gateways); both carry a strict JSON schema translated from the local
 * authoritative contracts, and the pipeline still validates every field.
 * Refusals, incomplete outputs and unparseable text are distinct errors,
 * never treated as evaluations.
 */

export type TextApiStyle = 'chat' | 'responses';

export interface TextClient {
  client: OpenAI;
  apiStyle: TextApiStyle;
  provider: 'openrouter' | 'openai';
}

/** Text-model client: OpenRouter (chat completions) or OpenAI (Responses API). */
export function createTextClient(config: ServerConfig, fetchImpl?: typeof fetch): TextClient {
  const client = new OpenAI({
    apiKey: config.textApiKey ?? '',
    ...(config.textBaseUrl ? { baseURL: config.textBaseUrl } : {}),
    ...(config.TEXT_AI_PROVIDER === 'openrouter' ? { defaultHeaders: { 'HTTP-Referer': 'https://marshmemos.app', 'X-Title': 'marshmemos' } } : {}),
    ...(fetchImpl ? { fetch: fetchImpl as never } : {}),
    maxRetries: 0, // retries are the worker's job, with recorded budgets
  });
  return { client, apiStyle: config.TEXT_AI_API_STYLE, provider: config.TEXT_AI_PROVIDER };
}

/** Audio client for AUDIO_AI_PROVIDER=openai (transcription + speech). */
export function createOpenAIAudioClient(config: ServerConfig, fetchImpl?: typeof fetch): OpenAI {
  return new OpenAI({
    apiKey: config.audioApiKey ?? '',
    ...(config.AUDIO_AI_BASE_URL ? { baseURL: config.AUDIO_AI_BASE_URL } : {}),
    ...(fetchImpl ? { fetch: fetchImpl as never } : {}),
    maxRetries: 0,
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
  text: TextClient,
  args: { model: string; instructions: string; data: unknown; schemaName: keyof typeof SCHEMAS; timeoutMs: number; templateVersion: string; repair?: RepairRequest | undefined },
): Promise<StructuredResult> {
  const started = Date.now();
  const schema = toProviderStrictSchema(SCHEMAS[args.schemaName] as Record<string, unknown>);
  // Only fixed server text enters the instruction channel; repair details ride in the data envelope.
  const instructions = [args.instructions, DATA_ENVELOPE_NOTE, args.repair ? `Repair note (${args.repair.code}): ${args.repair.note}` : null].filter(Boolean).join('\n\n');
  const data = args.repair?.details !== undefined ? { ...(args.data as Record<string, unknown>), repair_context: { code: args.repair.code, details: args.repair.details } } : args.data;
  const { text: output, model, usage } = text.apiStyle === 'chat'
    ? await chatCompletionCall(text, { model: args.model, instructions, data, schemaName: args.schemaName, schema, timeoutMs: args.timeoutMs })
    : await responsesCall(text.client, { model: args.model, instructions, data, schemaName: args.schemaName, schema, timeoutMs: args.timeoutMs });
  if (!output || output.trim().length === 0) throw new ProviderError('malformed_output', 'Model returned no text output.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new ProviderError('malformed_output', 'Model output was not valid JSON.');
  }
  return {
    raw: parsed,
    meta: {
      model: model ?? args.model,
      prompt_template_version: args.templateVersion,
      ...(usage ? { usage } : {}),
      latency_ms: Date.now() - started,
    },
  };
}

interface RawStructured {
  text: string | null;
  model: string | null;
  usage: Record<string, unknown> | null;
}

async function responsesCall(
  client: OpenAI,
  args: { model: string; instructions: string; data: unknown; schemaName: string; schema: Record<string, unknown>; timeoutMs: number },
): Promise<RawStructured> {
  let res: Awaited<ReturnType<OpenAI['responses']['create']>>;
  try {
    res = await client.responses.create(
      {
        model: args.model,
        instructions: args.instructions,
        input: [{ role: 'user', content: [{ type: 'input_text', text: JSON.stringify(args.data) }] }],
        text: { format: { type: 'json_schema', name: args.schemaName, schema: args.schema, strict: true } },
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
  return {
    text: response.output_text ?? null,
    model: response.model ?? null,
    usage: response.usage ? { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens, total_tokens: response.usage.total_tokens } : null,
  };
}

/**
 * Chat Completions with a strict JSON schema response format. On OpenRouter,
 * `provider.require_parameters` restricts routing to upstreams that honor
 * `response_format`, so a schema is never silently ignored.
 */
async function chatCompletionCall(
  text: TextClient,
  args: { model: string; instructions: string; data: unknown; schemaName: string; schema: Record<string, unknown>; timeoutMs: number },
): Promise<RawStructured> {
  const body: Record<string, unknown> = {
    model: args.model,
    messages: [
      { role: 'system', content: args.instructions },
      { role: 'user', content: JSON.stringify(args.data) },
    ],
    response_format: { type: 'json_schema', json_schema: { name: args.schemaName, strict: true, schema: args.schema } },
    max_tokens: 2000,
    ...(text.provider === 'openrouter' ? { provider: { require_parameters: true } } : {}),
  };
  let res: OpenAI.Chat.Completions.ChatCompletion;
  try {
    res = await text.client.chat.completions.create(body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, { timeout: args.timeoutMs });
  } catch (err) {
    throw classify(err);
  }
  const choice = res.choices?.[0];
  if (!choice) throw new ProviderError('malformed_output', 'Model returned no choices.');
  if (choice.message.refusal) throw new ProviderError('refusal', `Model refused: ${choice.message.refusal.slice(0, 200)}`);
  if (choice.finish_reason === 'content_filter') throw new ProviderError('refusal', 'Model output was filtered.');
  if (choice.finish_reason === 'length') throw new ProviderError('incomplete', 'Model output incomplete (max tokens).');
  const usage = res.usage
    ? { input_tokens: res.usage.prompt_tokens, output_tokens: res.usage.completion_tokens, total_tokens: res.usage.total_tokens }
    : null;
  return { text: typeof choice.message.content === 'string' ? choice.message.content : null, model: res.model ?? null, usage };
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
    private readonly text: TextClient,
    readonly model: string,
    private readonly templateVersion: string,
  ) {}
  async evaluate(input: EvaluationInput, opts: { timeoutMs: number; repair?: RepairRequest }) {
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
    return structuredCall(this.text, {
      model: this.model,
      instructions: PROMPT_TEMPLATES.evaluate,
      data,
      schemaName: 'evaluation',
      timeoutMs: opts.timeoutMs,
      templateVersion: this.templateVersion,
      repair: opts.repair,
    });
  }
}

export class OpenAIRewriter implements Rewriter {
  constructor(
    private readonly text: TextClient,
    readonly model: string,
    private readonly templateVersion: string,
  ) {}
  async rewrite(input: RewriteInput, opts: { timeoutMs: number; repair?: RepairRequest }) {
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
    return structuredCall(this.text, {
      model: this.model,
      instructions: PROMPT_TEMPLATES.rewrite,
      data,
      schemaName: 'rewrite',
      timeoutMs: opts.timeoutMs,
      templateVersion: this.templateVersion,
      repair: opts.repair,
    });
  }
}

export class OpenAIVerifier implements RewriteVerifier {
  constructor(
    private readonly text: TextClient,
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
    return structuredCall(this.text, {
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
    private readonly text: TextClient,
    readonly model: string,
    private readonly templateVersion: string,
  ) {}
  async reply(input: PartnerInput, opts: { timeoutMs: number }) {
    return structuredCall(this.text, {
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
