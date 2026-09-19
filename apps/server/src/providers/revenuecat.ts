import { timingSafeEqual } from 'node:crypto';
import type { EntitlementProvider, EntitlementSnapshot } from './types.js';

/**
 * RevenueCat entitlement provider. Webhook authenticity uses the configured
 * Authorization header value (RevenueCat's documented mechanism). Current
 * state is always re-fetched from the REST API rather than trusted from the
 * event body. Nothing here runs without the owner's credentials.
 */
export class RevenueCatEntitlements implements EntitlementProvider {
  readonly name = 'revenuecat' as const;
  constructor(
    private readonly opts: {
      secretApiKey: string;
      webhookAuth: string;
      entitlementId: string;
      environment: 'sandbox' | 'production';
      fetchImpl?: typeof fetch;
      baseUrl?: string;
    },
  ) {}

  verifyWebhook(headers: Record<string, string | undefined>): boolean {
    const given = headers['authorization'] ?? headers['Authorization'];
    if (!given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(this.opts.webhookAuth);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async fetch(appUserId: string): Promise<EntitlementSnapshot> {
    const f = this.opts.fetchImpl ?? fetch;
    const base = this.opts.baseUrl ?? 'https://api.revenuecat.com';
    const res = await f(`${base}/v1/subscribers/${encodeURIComponent(appUserId)}`, {
      headers: { Authorization: `Bearer ${this.opts.secretApiKey}`, Accept: 'application/json' },
    });
    if (res.status === 404) return none(appUserId);
    if (!res.ok) throw new Error(`revenuecat: subscriber fetch failed (${res.status})`);
    const body = (await res.json()) as {
      subscriber?: {
        entitlements?: Record<string, { expires_date: string | null; product_identifier: string; grace_period_expires_date?: string | null }>;
        subscriptions?: Record<string, { expires_date: string | null; unsubscribe_detected_at: string | null; billing_issues_detected_at: string | null; grace_period_expires_date: string | null; refunded_at?: string | null; store?: string; is_sandbox?: boolean }>;
      };
    };
    const ent = body.subscriber?.entitlements?.[this.opts.entitlementId];
    if (!ent) return none(appUserId);
    const sub = body.subscriber?.subscriptions?.[ent.product_identifier];
    const isSandbox = sub?.is_sandbox ?? this.opts.environment === 'sandbox';
    const env: EntitlementSnapshot['environment'] = isSandbox ? 'sandbox' : 'production';
    if (env !== this.opts.environment) {
      // Test purchases never unlock production and vice versa.
      return { ...none(appUserId), environment: env };
    }
    const now = Date.now();
    const expires = ent.expires_date ? new Date(ent.expires_date) : null;
    const grace = sub?.grace_period_expires_date ? new Date(sub.grace_period_expires_date) : null;
    if (sub?.refunded_at) return { state: 'revoked', product_id: ent.product_identifier, expires_at: expires, grace_until: null, environment: env, provider_customer_id: appUserId };
    if (expires && expires.getTime() > now) return { state: 'active', product_id: ent.product_identifier, expires_at: expires, grace_until: null, environment: env, provider_customer_id: appUserId };
    if (grace && grace.getTime() > now && sub?.billing_issues_detected_at) {
      return { state: 'grace', product_id: ent.product_identifier, expires_at: expires, grace_until: grace, environment: env, provider_customer_id: appUserId };
    }
    return { state: 'expired', product_id: ent.product_identifier, expires_at: expires, grace_until: null, environment: env, provider_customer_id: appUserId };
  }
}

function none(appUserId: string): EntitlementSnapshot {
  return { state: 'none', product_id: null, expires_at: null, grace_until: null, environment: null, provider_customer_id: appUserId };
}
