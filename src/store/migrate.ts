/** Applies db/migrations/*.sql in order, once each. */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { QueryFn } from './postgres.ts';

const DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));

export async function migrate(q: QueryFn, opts: { skip?: RegExp } = {}): Promise<string[]> {
  await q('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at bigint NOT NULL)');
  const done = new Set((await q('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const f of readdirSync(DIR).filter((x) => x.endsWith('.sql')).sort()) {
    if (done.has(f) || opts.skip?.test(f)) continue;
    const sql = readFileSync(DIR + f, 'utf8');
    // One simple-protocol query: the whole file and its bookkeeping commit or roll back together.
    await q(`BEGIN;\n${sql}\n;INSERT INTO schema_migrations (name, applied_at) VALUES ('${f.replace(/'/g, "''")}', ${Date.now()});\nCOMMIT;`);
    applied.push(f);
  }
  return applied;
}
