/**
 * Time helpers. Billing/AI allowance windows use UTC dates; the daily
 * learning date uses the learner's timezone as it was at assignment creation.
 */

const tzCache = new Map<string, Intl.DateTimeFormat>();

export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function formatter(tz: string): Intl.DateTimeFormat {
  let f = tzCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    tzCache.set(tz, f);
  }
  return f;
}

/** YYYY-MM-DD in the given IANA timezone. */
export function localDate(at: Date, tz: string): string {
  const parts = formatter(tz).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** YYYY-MM-DD in UTC (allowance window key). */
export function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Start of the next UTC day, when the allowance window resets. */
export function nextUtcMidnight(at: Date): Date {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1));
  return d;
}

export function addDays(dateYmd: string, days: number): string {
  const [y, m, d] = dateYmd.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

export function daysBetween(aYmd: string, bYmd: string): number {
  const [ay, am, ad] = aYmd.split('-').map(Number) as [number, number, number];
  const [by, bm, bd] = bYmd.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

export function hoursBetween(a: Date, b: Date): number {
  return Math.abs(b.getTime() - a.getTime()) / 3_600_000;
}
