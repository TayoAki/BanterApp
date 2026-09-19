import { validatePartnerSchema } from './schema.js';
import { isBlank } from './text.js';
import type { PartnerReply, ValidationResult } from './types.js';

export const ROLEPLAY_MAX_EXCHANGES = 3;

/**
 * Validates a partner reply. The server owns turn limits: when this is the
 * final allowed exchange the state is forced to ended regardless of output.
 */
export function validatePartnerReply(
  raw: unknown,
  ctx: { exchangeNumber: number; maxExchanges?: number },
): ValidationResult<PartnerReply> {
  const schema = validatePartnerSchema(raw);
  if (!schema.ok) return { ok: false, code: schema.code, message: schema.message, details: { errors: schema.errors } };
  const reply = { ...schema.value };
  const warnings: string[] = [];
  if (isBlank(reply.partner_reply)) return { ok: false, code: 'reply_blank', message: 'Partner reply is blank.' };
  const max = ctx.maxExchanges ?? ROLEPLAY_MAX_EXCHANGES;
  if (ctx.exchangeNumber < 1 || ctx.exchangeNumber > max) {
    return { ok: false, code: 'turn_out_of_bounds', message: `Exchange ${ctx.exchangeNumber} exceeds the ${max}-exchange limit.` };
  }
  if (ctx.exchangeNumber === max && reply.conversation_state !== 'ended') {
    reply.conversation_state = 'ended';
    warnings.push('server forced conversation_state=ended at the exchange limit');
  }
  return { ok: true, value: reply, warnings };
}
