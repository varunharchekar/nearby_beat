/** In-memory store for development, fixture mode and tests. Same semantics as the Postgres store. */
import type { ChangeEvent, Entity, SourceObservation } from '../domain/types.ts';
import type { AdapterRun, AuditEntry, Draft, Job, MagicLink, ObservationState, Report, Store, SubscriptionRequest } from './types.ts';

const c = <T>(v: T): T => structuredClone(v);

export class MemoryStore implements Store {
  drafts = new Map<string, Draft>();
  reports = new Map<string, Report>();
  requests = new Map<string, SubscriptionRequest>();
  links = new Map<string, MagicLink>();
  obsState = new Map<string, ObservationState>();
  observations = new Map<string, SourceObservation>();
  entities = new Map<string, Entity>();
  changes = new Map<string, ChangeEvent>();
  changeKeys = new Set<string>();
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
      for (const [rid, r] of this.reports) if (r.draftId === id) this.reports.delete(rid);
    }
    return n;
  }
  async saveReport(r: Report) { this.reports.set(r.id, c(r)); }
  async getReport(id: string) { const r = this.reports.get(id); return r ? c(r) : null; }
  async findReadyReport(draftId: string, key: string, since: number) {
    const list = [...this.reports.values()].filter((r) => r.draftId === draftId && r.prefsKey === key && r.status === 'ready' && r.createdAt >= since).sort((a, b) => b.createdAt - a.createdAt);
    return list[0] ? c(list[0]) : null;
  }
  async countReports(f: { draftId?: string; visitorKey?: string; since: number }) {
    let n = 0;
    for (const r of this.reports.values()) if (r.createdAt >= f.since && (!f.draftId || r.draftId === f.draftId) && (!f.visitorKey || r.visitorKey === f.visitorKey) && !['failed', 'timeout', 'interrupted'].includes(r.status)) n++;
    return n;
  }
  async listReports(limit = 100) { return [...this.reports.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map(c); }
  async interruptRunning(now: number) {
    let n = 0;
    for (const r of this.reports.values()) if (r.status === 'running') { r.status = 'interrupted'; r.error = 'The server restarted while this report was running.'; r.finishedAt = now; n++; }
    return n;
  }

  async saveSubscriptionRequest(r: SubscriptionRequest) { this.requests.set(r.id, { ...c(r), email: r.email.toLowerCase() }); }
  async getSubscriptionRequest(id: string) { const r = this.requests.get(id); return r ? c(r) : null; }
  async listSubscriptionRequests(limit = 200) { return [...this.requests.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit).map(c); }

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
