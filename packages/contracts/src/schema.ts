import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';

// ajv-formats is CommonJS (`module.exports = plugin; exports.default = plugin`).
const addFormats = addFormatsModule.default ?? (addFormatsModule as unknown as typeof addFormatsModule.default);

import evaluationSchema from './schemas/evaluation.schema.json' with { type: 'json' };
import rewriteSchema from './schemas/rewrite.schema.json' with { type: 'json' };
import rewriteVerificationSchema from './schemas/rewrite-verification.schema.json' with { type: 'json' };
import partnerSchema from './schemas/partner.schema.json' with { type: 'json' };
import type { Evaluation, PartnerReply, Rewrite, RewriteVerification } from './types.js';

export const SCHEMAS = {
  evaluation: evaluationSchema,
  rewrite: rewriteSchema,
  rewrite_verification: rewriteVerificationSchema,
  partner: partnerSchema,
} as const;

export type SchemaName = keyof typeof SCHEMAS;

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  // Models may return integer-valued numbers; JSON has no int type, so Ajv's
  // integer check (Number.isInteger) is what we want. No coercion.
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
});
addFormats(ajv);

const compiled: Partial<Record<SchemaName, ValidateFunction>> = {};

function validatorFor(name: SchemaName): ValidateFunction {
  const existing = compiled[name];
  if (existing) return existing;
  const fn = ajv.compile(SCHEMAS[name]);
  compiled[name] = fn;
  return fn;
}

export interface SchemaFailure {
  ok: false;
  code: 'schema_invalid';
  message: string;
  errors: Array<{ path: string; message: string; keyword: string }>;
}

export type SchemaResult<T> = { ok: true; value: T } | SchemaFailure;

function formatErrors(errors: ErrorObject[] | null | undefined) {
  return (errors ?? []).map((e) => ({
    path: e.instancePath || '/',
    message: e.message ?? 'invalid',
    keyword: e.keyword,
  }));
}

function check<T>(name: SchemaName, data: unknown): SchemaResult<T> {
  const fn = validatorFor(name);
  if (fn(data)) return { ok: true, value: data as T };
  const errors = formatErrors(fn.errors);
  return {
    ok: false,
    code: 'schema_invalid',
    message: `${name} output failed schema validation: ${errors
      .slice(0, 5)
      .map((e) => `${e.path} ${e.message}`)
      .join('; ')}`,
    errors,
  };
}

export const validateEvaluationSchema = (data: unknown) => check<Evaluation>('evaluation', data);
export const validateRewriteSchema = (data: unknown) => check<Rewrite>('rewrite', data);
export const validateRewriteVerificationSchema = (data: unknown) =>
  check<RewriteVerification>('rewrite_verification', data);
export const validatePartnerSchema = (data: unknown) => check<PartnerReply>('partner', data);
