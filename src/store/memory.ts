/** In-memory store for development, fixture mode and tests. Same semantics as the Postgres store. */
import type { ChangeEvent, Entity, SourceObservation } from '../domain/types.ts';
import type { LedgerEntry } from '../domain/ledger.ts';
import type { BillingRecord } from '../domain/billing.ts';
import type { Account, AdapterRun, AuditEntry, Draft, Issue, Job, MagicLink, ObservationState, Preview, Snapshot, Store, WaitlistEntry } from './types.ts';

const c = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements Store {
  drafts = new Map<string, Draft>();
  previews = new Map<string, Preview>();
  waitlist: WaitlistEntry[] = [];
  accounts = new Map<string, Account>();
  links = new Map<string, MagicLink>();
  obsState = new Map<string, ObservationState>();
  observations = new Map<string, SourceObservation>();
  entities = new Map<string, Entity>();
  changes = new Map<string, ChangeEvent>();
  changeKeys = new Set<string>();
  snapshots = new Map<string, Snapshot>();
  issues = new Map<string, Issue>();
  ledger = new Map<string, LedgerEntry[]>();
  billing = new Map<string, BillingRecord>();
  runs: AdapterRun[] = [];
  auditLog: AuditEntry[] = [];
  kv = new Map<string, unknown>();
  jobs = new Map<string, Job>();

  async saveDraft(d: Draft) { this.drafts.set(d.id, c(d)); }
  async getDraftByToken(h: string) { for (const d of this.drafts.values()) if (d.tokenHash === h) return c(d); return null; }
  async getDraft(id: string) { const d = this.drafts.get(id); return d ? c(d) : null; }
  async deleteExpiredDrafts(now: number) {
    let n = 0;
    for (const [id, d] of this.drafts) if (d.expiresAt <= now) {
      this.drafts.delete(id); n++;
      for (const [pid, p] of this.previews) if (p.draftId === id && !p.accountId) this.previews.delete(pid);
    }
    return n;
  }
  async savePreview(p: Preview) { this.previews.set(p.id, c(p)); }
  async getPreview(id: string) { const p = this.previews.get(id); return p ? c(p) : null; }
  async findReadyPreview(owner: string, key: string, snap: string) {
    for (const p of this.previews.values()) if ((p.draftId === owner || p.accountId === owner) && p.prefsKey === key && p.snapshotId === snap && p.status === 'ready' && !p.down.length) return c(p);
    return null;
  }
  async countPreviews(owner: string) { let n = 0; for (const p of this.previews.values()) if (p.draftId === owner || p.accountId === owner) n++; return n; }
  async addWaitlist(w: WaitlistEntry) { this.waitlist.push(c(w)); }

  async saveAccount(a: Account) { this.accounts.set(a.id, { ...c(a), email: a.email.toLowerCase() }); }
  async getAccount(id: string) { const a = this.accounts.get(id); return a ? c(a) : null; }
  async getAccountByEmail(e: string) { for (const a of this.accounts.values()) if (a.email === e.toLowerCase()) return c(a); return null; }
  async listAccounts() { return [...this.accounts.values()].map(c); }
  async deleteAccount(id: string) {
    this.accounts.delete(id);
    for (const [k, i] of this.issues) if (i.accountId === id) this.issues.delete(k);
    for (const [k, p] of this.previews) if (p.accountId === id) this.previews.delete(k);
    // Ledger and billing records are retained for billing and abuse prevention, without personal configuration.
  }
  async saveMagicLink(m: MagicLink) { this.links.set(m.tokenHash, c(m)); }
  async consumeMagicLink(h: string, now: number) {
    const m = this.links.get(h);
    if (!m || m.usedAt || m.expiresAt < now) return null;
    m.usedAt = now;
    return c(m);
  }
  async countMagicLinks(email: string, since: number) { let n = 0; for (const m of this.links.values()) if (m.email === email && m.createdAt >= since) n++; return n; }

  async getObservationState(a: string, r: string) { const s = this.obsState.get(`${a}|${r}`); return s ? c(s) : null; }
  async saveObservation(o: SourceObservation, s: ObservationState) { this.observations.set(o.id, c(o)); this.obsState.set(`${s.adapter}|${s.recordId}`, c(s)); }
  async getObservations(ids: string[]) { return ids.map((i) => this.observations.get(i)).filter(Boolean).map((o) => c(o!)); }
  async listEntities() { return [...this.entities.values()].map(c); }
  async saveEntity(e: Entity) { this.entities.set(e.id, c(e)); }
  async saveChange(ch: ChangeEvent) {
    const existing = this.changes.get(ch.id);
    if (!existing && this.changeKeys.has(ch.dedupeKey)) return false;
    this.changeKeys.add(ch.dedupeKey);
    this.changes.set(ch.id, c(ch));
    return true;
  }
  async getChange(id: string) { const x = this.changes.get(id); return x ? c(x) : null; }
  async listChanges(f: { review?: ChangeEvent['review']; since?: number; field?: 'approvedAt' | 'observedAt' } = {}) {
    return [...this.changes.values()].filter((x) => (!f.review || x.review === f.review) && (f.since == null || (x[f.field ?? 'observedAt'] ?? 0) > f.since)).map(c);
  }
  async saveSnapshot(s: Snapshot) { this.snapshots.set(s.id, c(s)); }

  async getIssueByKey(a: string, k: string) { const i = this.issues.get(`${a}|${k}`); return i ? c(i) : null; }
  async getIssueByMessageId(m: string) { for (const i of this.issues.values()) if (i.providerMessageId === m) return c(i); return null; }
  async saveIssue(i: Issue) { this.issues.set(`${i.accountId}|${i.scheduleKey}`, c(i)); }
  async listIssues(a: string) { return [...this.issues.values()].filter((i) => i.accountId === a).sort((x, y) => x.sunday - y.sunday).map(c); }
  async consumeCredit(a: string, e: LedgerEntry) {
    const l = this.ledger.get(a) ?? [];
    const ex = l.find((x) => x.issueKey === e.issueKey);
    if (ex && !ex.restoredAt) return false;
    if (ex) { ex.restoredAt = null; ex.consumedAt = e.consumedAt; ex.creditType = e.creditType; }
    else l.push(c(e));
    this.ledger.set(a, l);
    return true;
  }
  async restoreCredit(a: string, k: string, at: number) { const e = (this.ledger.get(a) ?? []).find((x) => x.issueKey === k); if (e && !e.restoredAt) e.restoredAt = at; }
  async listLedger(a: string) { return c(this.ledger.get(a) ?? []); }

  async getBilling(a: string) { const b = this.billing.get(a); return b ? c(b) : null; }
  async saveBilling(a: string, b: BillingRecord) { this.billing.set(a, c(b)); }
  async findAccountIdByCustomer(cus: string) { for (const [a, b] of this.billing) if (b.customerId === cus) return a; return null; }

  async recordAdapterRun(r: AdapterRun) { this.runs.unshift(c(r)); this.runs = this.runs.slice(0, 500); }
  async listAdapterRuns(limit = 100) { return this.runs.slice(0, limit).map(c); }
  async audit(e: AuditEntry) { this.auditLog.unshift(c(e)); }
  async listAudit(limit = 200) { return this.auditLog.slice(0, limit).map(c); }
  async kvGet<T>(k: string) { return this.kv.has(k) ? c(this.kv.get(k) as T) : null; }
  async kvSet(k: string, v: unknown) { this.kv.set(k, c(v)); }

  async enqueueJob(j: Omit<Job, 'attempts' | 'status' | 'lastError'>) {
    for (const x of this.jobs.values()) if (x.key === j.key) return false;
    this.jobs.set(j.id, { ...c(j), attempts: 0, status: 'queued', lastError: null });
    return true;
  }
  async claimJob(now: number) {
    const j = [...this.jobs.values()].filter((x) => x.status === 'queued' && x.runAt <= now).sort((a, b) => a.runAt - b.runAt)[0];
    if (!j) return null;
    j.status = 'running'; j.attempts++;
    return c(j);
  }
  async finishJob(id: string, ok: boolean, error: string | null, retryAt: number | null) {
    const j = this.jobs.get(id);
    if (!j) return;
    if (ok) j.status = 'done';
    else if (retryAt != null) { j.status = 'queued'; j.runAt = retryAt; j.lastError = error; }
    else { j.status = 'dead'; j.lastError = error; }
  }
  async listJobs(limit = 100) { return [...this.jobs.values()].slice(-limit).map(c); }
}
