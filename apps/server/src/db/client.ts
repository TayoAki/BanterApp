import postgres, { type Sql, type TransactionSql } from 'postgres';

export type Db = Sql;
export type Tx = TransactionSql;

export function createDb(url: string, options: { max?: number } = {}): Db {
  return postgres(url, {
    max: options.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 15,
    prepare: true,
    // Return bigint columns as numbers where safe; row counts stay small.
    transform: { undefined: null },
    onnotice: () => {},
  });
}

/** Postgres error helpers for translating constraint/quota failures. */
export function pgErrorCode(err: unknown): string | null {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return null;
}

export function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === '23505';
}

export function isQuotaExceeded(err: unknown): boolean {
  return err instanceof Error && /quota_exceeded/.test(err.message);
}
