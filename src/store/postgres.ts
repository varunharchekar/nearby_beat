/**
 * PostgreSQL store. Rows keep indexed key columns plus a JSON body.
 * Personal location data is sealed (AES-256-GCM) before it reaches the database.
 */
import type { ChangeEvent, Entity, SourceObservation } from '../domain/types.ts';
import type { AdapterRun, AuditEntry, Draft, Job, MagicLink, ObservationState, Report, Store, SubscriptionRequest } from './types.ts';
import { open, seal, sha256 } from '../lib/crypto.ts';

export type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;

/** Create a query function backed by node-postgres. `pg` is loaded lazily so memory mode needs no install. */
export async function pgQuery(databaseUrl: string): Promise<{ query: QueryFn; end: () => Promise<void> }> {
  const mod: any = await import('pg');
  const pg = mod.default ?? mod;
  pg.types.setTypeParser(20, (v: string) => Number(v)); // bigint epoch ms → number
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  return { query: (sql, params) => pool.query(sql, params), end: () => pool.end() };
}

const J = (v: unknown) => JSON.stringify(v);

export class PgStore implements Store {
  private q: QueryFn;
  private key: Buffer;
  constructor(q: QueryFn, key: Buffer) { this.q = q; this.key = key; }

  private s(v: unknown) { return seal(v, this.key); }
  private o<T>(t: string): T { return open<T>(t, this.key); }

  async saveDraft(d: Draft) {
    await this.q(`INSERT INTO drafts (id, token_hash, created_at, expires_at, sealed) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (id) DO UPDATE SET expires_at = EXCLUDED.expires_at, sealed = EXCLUDED.sealed`, [d.id, d.tokenHash, d.createdAt, d.expiresAt, this.s(d)]);
  }
  async getDraftByToken(h: string) { const r = await this.q(`SELECT sealed FROM drafts WHERE token_hash = $1`, [h]); return r.rows[0] ? this.o<Draft>(r.rows[0].sealed) : null; }
  async getDraft(id: string) { const r = await this.q(`SELECT sealed FROM drafts WHERE id = $1`, [id]); return r.rows[0] ? this.o<Draft>(r.rows[0].sealed) : null; }
  async deleteExpiredDrafts(now: number) {
    await this.q(`DELETE FROM reports WHERE draft_id IN (SELECT id FROM drafts WHERE expires_at <= $1)`, [now]);
    const r = await this.q(`DELETE FROM drafts WHERE expires_at <= $1`, [now]);
    return r.rowCount;
  }
  async saveReport(x: Report) {
    const { prefs, ...rest } = x;
    await this.q(`INSERT INTO reports (id, draft_id, visitor_key, prefs_key_hash, status, created_at, expires_at, data, sealed)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
      ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, expires_at = EXCLUDED.expires_at, data = EXCLUDED.data, sealed = EXCLUDED.sealed`,
    [x.id, x.draftId, x.visitorKey, sha256(x.prefsKey), x.status, x.createdAt, x.expiresAt, J(rest), this.s(prefs)]);
  }
  private rep(row: any): Report { return { ...row.data, prefs: this.o(row.sealed) }; }
  async getReport(id: string) { const r = await this.q(`SELECT data, sealed FROM reports WHERE id = $1`, [id]); return r.rows[0] ? this.rep(r.rows[0]) : null; }
  async findReadyReport(draftId: string, key: string, since: number) {
    const r = await this.q(`SELECT data, sealed FROM reports WHERE draft_id = $1 AND prefs_key_hash = $2 AND status = 'ready' AND created_at >= $3 ORDER BY created_at DESC LIMIT 1`, [draftId, sha256(key), since]);
    return r.rows[0] ? this.rep(r.rows[0]) : null;
  }
  async countReports(f: { draftId?: string; visitorKey?: string; since: number }) {
    const r = await this.q(`SELECT count(*)::int AS n FROM reports WHERE created_at >= $1 AND ($2::text IS NULL OR draft_id = $2) AND ($3::text IS NULL OR visitor_key = $3) AND status NOT IN ('failed','timeout','interrupted')`, [f.since, f.draftId ?? null, f.visitorKey ?? null]);
    return Number(r.rows[0].n);
  }
  async listReports(limit = 100) { const r = await this.q(`SELECT data, sealed FROM reports ORDER BY created_at DESC LIMIT $1`, [limit]); return r.rows.map((x) => this.rep(x)); }
  async interruptRunning(now: number) {
    const r = await this.q(`SELECT data, sealed FROM reports WHERE status = 'running'`);
    for (const row of r.rows) { const x = this.rep(row); x.status = 'interrupted'; x.error = 'The server restarted while this report was running.'; x.finishedAt = now; await this.saveReport(x); }
    return r.rows.length;
  }

  async saveSubscriptionRequest(x: SubscriptionRequest) {
    const { prefs, email, ...rest } = x;
    await this.q(`INSERT INTO subscription_requests (id, email, status, created_at, data, sealed) VALUES ($1,$2,$3,$4,$5::jsonb,$6)
      ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data, sealed = EXCLUDED.sealed`,
    [x.id, email.toLowerCase(), x.status, x.createdAt, J(rest), this.s(prefs)]);
  }
  private req(row: any): SubscriptionRequest { return { ...row.data, email: row.email, prefs: this.o(row.sealed) }; }
  async getSubscriptionRequest(id: string) { const r = await this.q(`SELECT email, data, sealed FROM subscription_requests WHERE id = $1`, [id]); return r.rows[0] ? this.req(r.rows[0]) : null; }
  async listSubscriptionRequests(limit = 200) { const r = await this.q(`SELECT email, data, sealed FROM subscription_requests ORDER BY created_at DESC LIMIT $1`, [limit]); return r.rows.map((x) => this.req(x)); }

  async saveMagicLink(m: MagicLink) {
    await this.q(`INSERT INTO magic_links (token_hash, email, purpose, payload, expires_at, used_at, created_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)`,
      [m.tokenHash, m.email, m.purpose, J(m.payload ?? {}), m.expiresAt, m.usedAt, m.createdAt]);
  }
  async consumeMagicLink(h: string, now: number) {
    const r = await this.q(`UPDATE magic_links SET used_at = $2 WHERE token_hash = $1 AND used_at IS NULL AND expires_at >= $2
      RETURNING token_hash, email, purpose, payload, expires_at, used_at, created_at`, [h, now]);
    const x = r.rows[0];
    return x ? { tokenHash: x.token_hash, email: x.email, purpose: x.purpose, payload: x.payload, expiresAt: Number(x.expires_at), usedAt: Number(x.used_at), createdAt: Number(x.created_at) } : null;
  }
  async countMagicLinks(email: string, since: number) { const r = await this.q(`SELECT count(*)::int AS n FROM magic_links WHERE email = $1 AND created_at >= $2`, [email, since]); return Number(r.rows[0].n); }

  async getObservationState(a: string, rec: string) {
    const r = await this.q(`SELECT adapter, record_id, content_hash, facts, last_observation_id FROM observation_state WHERE adapter = $1 AND record_id = $2`, [a, rec]);
    const x = r.rows[0];
    return x ? { adapter: x.adapter, recordId: x.record_id, contentHash: x.content_hash, facts: x.facts, lastObservationId: x.last_observation_id } : null;
  }
  async saveObservation(o: SourceObservation, s: ObservationState) {
    await this.q(`INSERT INTO source_observations (id, adapter, record_id, family, canonical_url, content_hash, published_at, observed_at, data)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT (id) DO NOTHING`,
    [o.id, o.adapter, o.recordId, o.family, o.url, o.contentHash, o.publishedAt, o.observedAt, J(o)]);
    await this.q(`INSERT INTO observation_state (adapter, record_id, content_hash, facts, last_observation_id) VALUES ($1,$2,$3,$4::jsonb,$5)
      ON CONFLICT (adapter, record_id) DO UPDATE SET content_hash = EXCLUDED.content_hash, facts = EXCLUDED.facts, last_observation_id = EXCLUDED.last_observation_id`,
    [s.adapter, s.recordId, s.contentHash, J(s.facts), s.lastObservationId]);
  }
  async getObservations(ids: string[]) {
    if (!ids.length) return [];
    const r = await this.q(`SELECT data FROM source_observations WHERE id = ANY($1::text[])`, [ids]);
    return r.rows.map((x) => x.data as SourceObservation);
  }
  async listEntities() { const r = await this.q(`SELECT data FROM entities`); return r.rows.map((x) => x.data as Entity); }
  async saveEntity(e: Entity) { await this.q(`INSERT INTO entities (id, key, data) VALUES ($1,$2,$3::jsonb) ON CONFLICT (id) DO UPDATE SET key = EXCLUDED.key, data = EXCLUDED.data`, [e.id, e.key, J(e)]); }
  async saveChange(c: ChangeEvent) {
    const u = await this.q(`UPDATE change_events SET review_state = $2, approved_at = $3, data = $4::jsonb WHERE id = $1`, [c.id, c.review, c.approvedAt ?? null, J(c)]);
    if (u.rowCount) return true;
    const r = await this.q(`INSERT INTO change_events (id, dedupe_key, entity_id, review_state, observed_at, approved_at, data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
      ON CONFLICT (dedupe_key) DO NOTHING`, [c.id, c.dedupeKey, c.entityId, c.review, c.observedAt, c.approvedAt ?? null, J(c)]);
    return r.rowCount === 1;
  }
  async getChange(id: string) { const r = await this.q(`SELECT data FROM change_events WHERE id = $1`, [id]); return r.rows[0]?.data ?? null; }
  async listChanges(f: { review?: ChangeEvent['review']; since?: number; field?: 'approvedAt' | 'observedAt' } = {}) {
    const col = f.field === 'approvedAt' ? 'approved_at' : 'observed_at';
    const r = await this.q(`SELECT data FROM change_events WHERE ($1::text IS NULL OR review_state = $1) AND ($2::bigint IS NULL OR ${col} > $2) ORDER BY observed_at`, [f.review ?? null, f.since ?? null]);
    return r.rows.map((x) => x.data as ChangeEvent);
  }

  async recordAdapterRun(x: AdapterRun) { await this.q(`INSERT INTO adapter_runs (adapter, at, ok, count, error) VALUES ($1,$2,$3,$4,$5)`, [x.adapter, x.at, x.ok, x.count, x.error]); }
  async listAdapterRuns(limit = 100) {
    const r = await this.q(`SELECT adapter, at, ok, count, error FROM adapter_runs ORDER BY at DESC, id DESC LIMIT $1`, [limit]);
    return r.rows.map((x) => ({ adapter: x.adapter, at: Number(x.at), ok: x.ok, count: Number(x.count), error: x.error }));
  }
  async audit(e: AuditEntry) { await this.q(`INSERT INTO audit_log (at, actor, op, detail) VALUES ($1,$2,$3,$4)`, [e.at, e.actor, e.op, e.detail]); }
  async listAudit(limit = 200) { const r = await this.q(`SELECT at, actor, op, detail FROM audit_log ORDER BY id DESC LIMIT $1`, [limit]); return r.rows.map((x) => ({ ...x, at: Number(x.at) })); }
  async kvGet<T>(k: string) { const r = await this.q(`SELECT v FROM kv WHERE k = $1`, [k]); return r.rows[0] ? (r.rows[0].v as T) : null; }
  async kvSet(k: string, v: unknown) { await this.q(`INSERT INTO kv (k, v) VALUES ($1,$2::jsonb) ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v`, [k, J(v)]); }

  async enqueueJob(j: Omit<Job, 'attempts' | 'status' | 'lastError'>) {
    const r = await this.q(`INSERT INTO jobs (id, type, key, payload, run_at, attempts, status) VALUES ($1,$2,$3,$4::jsonb,$5,0,'queued') ON CONFLICT (key) DO NOTHING`, [j.id, j.type, j.key, J(j.payload), j.runAt]);
    return r.rowCount === 1;
  }
  async claimJob(now: number) {
    const r = await this.q(`UPDATE jobs SET status = 'running', attempts = attempts + 1
      WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_at <= $1 ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, type, key, payload, run_at, attempts, status, last_error`, [now]);
    const x = r.rows[0];
    return x ? { id: x.id, type: x.type, key: x.key, payload: x.payload, runAt: Number(x.run_at), attempts: Number(x.attempts), status: x.status, lastError: x.last_error } : null;
  }
  async finishJob(id: string, ok: boolean, error: string | null, retryAt: number | null) {
    if (ok) await this.q(`UPDATE jobs SET status = 'done', last_error = NULL WHERE id = $1`, [id]);
    else if (retryAt != null) await this.q(`UPDATE jobs SET status = 'queued', run_at = $2, last_error = $3 WHERE id = $1`, [id, retryAt, error]);
    else await this.q(`UPDATE jobs SET status = 'dead', last_error = $2 WHERE id = $1`, [id, error]);
  }
  async listJobs(limit = 100) {
    const r = await this.q(`SELECT id, type, key, payload, run_at, attempts, status, last_error FROM jobs ORDER BY run_at DESC LIMIT $1`, [limit]);
    return r.rows.map((x) => ({ id: x.id, type: x.type, key: x.key, payload: x.payload, runAt: Number(x.run_at), attempts: Number(x.attempts), status: x.status, lastError: x.last_error }));
  }
}
