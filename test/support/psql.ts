/**
 * Test-only query executor that runs PgStore SQL through the `psql` CLI against a local Postgres.
 * Used where the `pg` npm package is not installed. Parameters are inlined as properly quoted literals.
 */
import { execFileSync } from 'node:child_process';
import type { QueryFn } from '../../src/store/postgres.ts';

function lit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (Array.isArray(v)) return v.length ? `ARRAY[${v.map(lit).join(',')}]` : `'{}'`;
  return `E'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function psqlQuery(opts: { host: string; port: string; user: string; db: string }): QueryFn {
  const run = (sql: string) => execFileSync('psql', ['-h', opts.host, '-p', opts.port, '-U', opts.user, '-d', opts.db, '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql], { encoding: 'utf8' });
  return async (sql, params = []) => {
    const inlined = sql.replace(/\$(\d+)/g, (_, n) => lit(params[Number(n) - 1]));
    if (/^\s*select\b/i.test(inlined) || /\breturning\b/i.test(inlined)) {
      const out = run(`WITH t AS (${inlined}) SELECT coalesce(json_agg(t), '[]'::json) FROM t`).trim();
      const rows = JSON.parse(out || '[]');
      return { rows, rowCount: rows.length };
    }
    const out = run(inlined).trim().split('\n').pop() ?? '';
    const m = out.match(/(\d+)\s*$/);
    return { rows: [], rowCount: m ? Number(m[1]) : 0 };
  };
}
