import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

describe('handoff packet and repository shape', () => {
  it('the bundled handoff still passes its own offline validator', () => {
    const out = execFileSync('python3', ['scripts/validate_handoff.py'], { cwd: path.join(root, 'handoff'), encoding: 'utf8' });
    expect(out).toMatch(/^PASS:/m);
  });

  it('keeps the expected repository layout', () => {
    for (const p of [
      'apps/mobile/app.json',
      'apps/server/src/entry/api.ts',
      'apps/server/src/entry/worker.ts',
      'packages/contracts/src/index.ts',
      'packages/content/src/index.ts',
      'supabase/migrations/20260919000000_init.sql',
      'supabase/migrations/20260919000100_functions.sql',
      'supabase/migrations/20260919000200_rls.sql',
      'supabase/migrations/20260919000300_password_auth.sql',
      'apps/server/Dockerfile',
      '.env.example',
      'PLAN.md',
      'CLAUDE.md',
    ]) {
      expect(existsSync(path.join(root, p)), p).toBe(true);
    }
  });

  it('never ships real secrets in the env example', () => {
    const text = execFileSync('cat', ['.env.example'], { cwd: root, encoding: 'utf8' });
    for (const line of text.split('\n')) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line);
      if (!m) continue;
      const [, name, value] = m;
      if (/KEY|SECRET|TOKEN|DSN|DATABASE_URL|AUTH$/.test(name!)) expect(value!.split('#')[0]!.trim(), name).toBe('');
    }
  });
});
