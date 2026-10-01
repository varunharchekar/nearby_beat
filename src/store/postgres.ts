/**
 * PostgreSQL store. Rows keep indexed key columns plus a JSON body.
 * Personal location data is sealed (AES-256-GCM) before it reaches the database.
 */
import type { ChangeEvent, Entity, SourceObservation } from '../domain/types.ts';
import type { LedgerEntry } from '../domain/ledger.ts';
import type { BillingRecord } from '../domain/billing.ts';
import type { Account, AdapterRun, AuditEntry, Draft, Issue, Job, MagicLink, ObservationState, Preview, Snapshot, Store, WaitlistEntry } from './types.ts';
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
    await this.q(`DELETE FROM previews WHERE account_id IS NULL AND draft_id IN (SELECT id FROM drafts WHERE expires_at <= $1)`, [now]);
    const r = await this.q(`DELETE FROM drafts WHERE expires_at <= $1`, [now]);
    return r.rowCount;
  }
  async savePreview(p: Preview) {
    await this.q(`INSERT INTO previews (id, draft_id, account_id, prefs_key_hash, snapshot_id, status, partial, created_at, expires_at, sealed)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (id) DO UPDATE SET account_id = EXCLUDED.account_id, status = EXCLUDED.status, partial = EXCLUDED.partial, expires_at = EXCLUDED.expires_at, sealed = EXCLUDED.sealed`,
    [p.id, p.draftId, p.accountId, sha256(p.prefsKey), p.snapshotId, p.status, p.down.length > 0, p.createdAt, p.expiresAt, this.s(p)]);
  }
  async getPreview(id: string) { const r = await this.q(`SELECT sealed FROM previews WHERE id = $1`, [id]); return r.rows[0] ? this.o<Preview>(r.rows[0].sealed) : null; }
  async findReadyPreview(owner: string, key: string, snap: string) {
    const r = await this.q(`SELECT sealed FROM previews WHERE (draft_id = $1 OR account_id = $1) AND prefs_key_hash = $2 AND snapshot_id = $3 AND status = 'ready' AND NOT partial ORDER BY created_at DESC LIMIT 1`, [owner, sha256(key), snap]);
    return r.rows[0] ? this.o<Preview>(r.rows[0].sealed) : null;
  }
  async countPreviews(owner: string) { const r = await this.q(`SELECT count(*)::int AS n FROM previews WHERE draft_id = $1 OR account_id = $1`, [owner]); return Number(r.rows[0].n); }
  async addWaitlist(w: WaitlistEntry) { await this.q(`INSERT INTO waitlist (id, email, area, consent_at, created_at) VALUES ($1,$2,$3,$4,$5)`, [w.id, w.email, w.area, w.consentAt, w.createdAt]); }

  async saveAccount(a: Account) {
    const { prefs, ...rest } = a;
    await this.q(`INSERT INTO accounts (id, email, created_at, email_state, data, sealed) VALUES ($1,$2,$3,$4,$5::jsonb,$6)
      ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, email_state = EXCLUDED.email_state, data = EXCLUDED.data, sealed = EXCLUDED.sealed`,
    [a.id, a.email.toLowerCase(), a.createdAt, a.emailState, J(rest), this.s(prefs)]);
  }
  private acct(row: any): Account { return { ...row.data, prefs: this.o(row.sealed) }; }
  async getAccount(id: string) { const r = await this.q(`SELECT data, sealed FROM accounts WHERE id = $1`, [id]); return r.rows[0] ? this.acct(r.rows[0]) : null; }
  async getAccountByEmail(e: string) { const r = await this.q(`SELECT data, sealed FROM accounts WHERE email = $1`, [e.toLowerCase()]); return r.rows[0] ? this.acct(r.rows[0]) : null; }
  async listAccounts() { const r = await this.q(`SELECT data, sealed FROM accounts ORDER BY created_at`); return r.rows.map((x) => this.acct(x)); }
  async deleteAccount(id: string) {
    await this.q(`DELETE FROM previews WHERE account_id = $1`, [id]);
    await this.q(`DELETE FROM accounts WHERE id = $1`, [id]);
  }
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
  async saveSnapshot(s: Snapshot) { await this.q(`INSERT INTO snapshots (id, at, change_ids) VALUES ($1,$2,$3::jsonb) ON CONFLICT (id) DO NOTHING`, [s.id, s.at, J(s.changeIds)]); }

  async getIssueByKey(a: string, k: string) { const r = await this.q(`SELECT data FROM newsletter_issues WHERE account_id = $1 AND schedule_key = $2`, [a, k]); return r.rows[0]?.data ?? null; }
  async getIssueByMessageId(m: string) { const r = await this.q(`SELECT data FROM newsletter_issues WHERE provider_message_id = $1`, [m]); return r.rows[0]?.data ?? null; }
  async saveIssue(i: Issue) {
    await this.q(`INSERT INTO newsletter_issues (id, account_id, schedule_key, sunday, status, provider_message_id, data) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
      ON CONFLICT (account_id, schedule_key) DO UPDATE SET status = EXCLUDED.status, provider_message_id = EXCLUDED.provider_message_id, data = EXCLUDED.data`,
    [i.id, i.accountId, i.scheduleKey, i.sunday, i.status, i.providerMessageId, J(i)]);
  }
  async listIssues(a: string) { const r = await this.q(`SELECT data FROM newsletter_issues WHERE account_id = $1 ORDER BY sunday`, [a]); return r.rows.map((x) => x.data as Issue); }
  async consumeCredit(a: string, e: LedgerEntry) {
    const r = await this.q(`INSERT INTO entitlement_ledger (account_id, issue_key, credit_type, consumed_at, restored_at) VALUES ($1,$2,$3,$4,NULL)
      ON CONFLICT (account_id, issue_key) DO UPDATE SET credit_type = EXCLUDED.credit_type, consumed_at = EXCLUDED.consumed_at, restored_at = NULL
      WHERE entitlement_ledger.restored_at IS NOT NULL RETURNING issue_key`, [a, e.issueKey, e.creditType, e.consumedAt]);
    return r.rowCount === 1;
  }
  async restoreCredit(a: string, k: string, at: number) { await this.q(`UPDATE entitlement_ledger SET restored_at = $3 WHERE account_id = $1 AND issue_key = $2 AND restored_at IS NULL`, [a, k, at]); }
  async listLedger(a: string) {
    const r = await this.q(`SELECT issue_key, credit_type, consumed_at, restored_at FROM entitlement_ledger WHERE account_id = $1 ORDER BY consumed_at`, [a]);
    return r.rows.map((x) => ({ issueKey: x.issue_key, creditType: x.credit_type, consumedAt: Number(x.consumed_at), restoredAt: x.restored_at == null ? null : Number(x.restored_at) }));
  }

  async getBilling(a: string) { const r = await this.q(`SELECT data FROM billing WHERE account_id = $1`, [a]); return r.rows[0]?.data ?? null; }
  async saveBilling(a: string, b: BillingRecord) {
    await this.q(`INSERT INTO billing (account_id, customer_id, data) VALUES ($1,$2,$3::jsonb) ON CONFLICT (account_id) DO UPDATE SET customer_id = EXCLUDED.customer_id, data = EXCLUDED.data`, [a, b.customerId, J(b)]);
  }
  async findAccountIdByCustomer(c: string) { const r = await this.q(`SELECT account_id FROM billing WHERE customer_id = $1`, [c]); return r.rows[0]?.account_id ?? null; }

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
