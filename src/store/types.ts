import type { ChangeEvent, Entity, ObservationFacts, Prefs, SourceObservation } from '../domain/types.ts';
import type { StructuredIssue } from '../domain/issue.ts';
import type { Progress, Usage } from '../research/types.ts';

export interface GeoCandidate { id: string; label: string; city: string; point: [number, number]; kind: string; covered: boolean; approx: boolean }

export interface Draft {
  id: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  candidates: GeoCandidate[] | null;
  prefs: Prefs | null;
  ack: boolean;
  /** Reports started from this draft (budget). */
  runs: number;
  currentReportId: string | null;
  /** Proposed shapes awaiting confirmation. */
  proposals: { id: string; mode: 'include' | 'exclude'; shape: import('../domain/types.ts').Shape }[];
  geoNote: string | null;
  /** A street named without endpoints: ask which stretch before proposing anything. */
  clarify: { mode: 'include' | 'exclude'; road: string; text: string } | null;
}

export interface Report {
  id: string;
  draftId: string;
  /** Salted daily hash of the visitor, for rate limits. Not an IP address. */
  visitorKey: string;
  version: number;
  prefsKey: string;
  prefs: Prefs;
  status: 'running' | 'ready' | 'failed' | 'timeout' | 'interrupted';
  error: string | null;
  progress: Progress;
  summary: string | null;
  issue: StructuredIssue | null;
  dropped: { name: string; reason: string }[];
  usage: Usage | null;
  researcher: string;
  createdAt: number;
  finishedAt: number | null;
  expiresAt: number;
  /** Subscription runs: cover only news since this time (default: the lookback window). */
  since?: number | null;
  /** Subscription runs: the request this weekly report is for, and items sent in earlier issues. */
  subscriptionId?: string | null;
  previouslyReported?: string[];
}

/** A visitor asking to receive this report weekly. The subscription service picks these up. */
export interface SubscriptionRequest {
  id: string;
  email: string;
  reportId: string;
  prefs: Prefs;
  consentAt: number;
  marketing: boolean;
  status: 'pending_confirmation' | 'confirmed' | 'handed_off';
  createdAt: number;
  confirmedAt: number | null;
  /** End of the period the latest weekly run covered; the next run starts here. */
  coveredTo?: number | null;
  /** Item names sent in recent issues, so repeats are only included with a new update. */
  sentNames?: string[];
}

export interface MagicLink { tokenHash: string; email: string; purpose: string; payload: any; expiresAt: number; usedAt: number | null; createdAt: number }
export interface ObservationState { adapter: string; recordId: string; contentHash: string; facts: ObservationFacts; lastObservationId: string }
export interface AdapterRun { adapter: string; at: number; ok: boolean; count: number; error: string | null }
export interface AuditEntry { at: number; actor: string; op: string; detail: string }
export interface Job { id: string; type: string; key: string; payload: any; runAt: number; attempts: number; status: 'queued' | 'running' | 'done' | 'dead'; lastError: string | null }

export interface Store {
  // drafts and reports
  saveDraft(d: Draft): Promise<void>;
  getDraftByToken(tokenHash: string): Promise<Draft | null>;
  getDraft(id: string): Promise<Draft | null>;
  deleteExpiredDrafts(now: number): Promise<number>;
  saveReport(r: Report): Promise<void>;
  getReport(id: string): Promise<Report | null>;
  findReadyReport(draftId: string, prefsKey: string, since: number): Promise<Report | null>;
  countReports(f: { draftId?: string; visitorKey?: string; since: number }): Promise<number>;
  listReports(limit?: number): Promise<Report[]>;
  /** Mark reports left running by a previous process as interrupted. */
  interruptRunning(now: number): Promise<number>;

  // subscription requests
  saveSubscriptionRequest(r: SubscriptionRequest): Promise<void>;
  getSubscriptionRequest(id: string): Promise<SubscriptionRequest | null>;
  listSubscriptionRequests(limit?: number): Promise<SubscriptionRequest[]>;

  // magic links
  saveMagicLink(m: MagicLink): Promise<void>;
  consumeMagicLink(tokenHash: string, now: number): Promise<MagicLink | null>;
  countMagicLinks(email: string, since: number): Promise<number>;

  // official records
  getObservationState(adapter: string, recordId: string): Promise<ObservationState | null>;
  saveObservation(o: SourceObservation, state: ObservationState): Promise<void>;
  getObservations(ids: string[]): Promise<SourceObservation[]>;
  listEntities(): Promise<Entity[]>;
  saveEntity(e: Entity): Promise<void>;
  saveChange(c: ChangeEvent): Promise<boolean>;
  getChange(id: string): Promise<ChangeEvent | null>;
  listChanges(filter?: { review?: ChangeEvent['review']; since?: number; field?: 'approvedAt' | 'observedAt' }): Promise<ChangeEvent[]>;

  // operations
  recordAdapterRun(r: AdapterRun): Promise<void>;
  listAdapterRuns(limit?: number): Promise<AdapterRun[]>;
  audit(e: AuditEntry): Promise<void>;
  listAudit(limit?: number): Promise<AuditEntry[]>;
  kvGet<T>(k: string): Promise<T | null>;
  kvSet(k: string, v: unknown): Promise<void>;

  // jobs
  enqueueJob(j: Omit<Job, 'attempts' | 'status' | 'lastError'>): Promise<boolean>;
  claimJob(now: number): Promise<Job | null>;
  finishJob(id: string, ok: boolean, error: string | null, retryAt: number | null): Promise<void>;
  listJobs(limit?: number): Promise<Job[]>;
}
