import type { ChangeEvent, Entity, IssueContent, ObservationFacts, Prefs, SourceObservation } from '../domain/types.ts';
import type { EmailState, LedgerEntry } from '../domain/ledger.ts';
import type { BillingRecord } from '../domain/billing.ts';
import type { StructuredIssue } from '../domain/issue.ts';

export interface GeoCandidate { id: string; label: string; city: string; point: [number, number]; kind: string; covered: boolean; approx: boolean }

export interface Draft {
  id: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  candidates: GeoCandidate[] | null;
  prefs: Prefs | null;
  ack: boolean;
  gens: number;
  currentPreviewId: string | null;
  approvedPreviewId: string | null;
  /** Proposed shapes awaiting confirmation. */
  proposals: { id: string; mode: 'include' | 'exclude'; shape: import('../domain/types.ts').Shape }[];
  geoNote: string | null;
}

export interface Preview {
  id: string;
  draftId: string | null;
  accountId: string | null;
  version: number;
  prefsKey: string;
  prefs: Prefs;
  snapshotId: string;
  periodFrom: number;
  periodTo: number;
  status: 'running' | 'ready' | 'failed' | 'timeout';
  error: string | null;
  content: IssueContent | null;
  issue: StructuredIssue | null;
  down: string[];
  cached: boolean;
  createdAt: number;
  approvedAt: number | null;
  expiresAt: number;
}

export interface Account {
  id: string;
  email: string;
  verifiedAt: number | null;
  tz: string;
  consentVersion: string | null;
  consentAt: number | null;
  marketingConsent: boolean;
  emailState: EmailState;
  paused: boolean;
  firstIssueAt: number;
  lastCutoff: number;
  checkoutPending: boolean;
  checkoutPlan: 'monthly' | 'annual' | null;
  prefs: Prefs;
  prefsVersion: number;
  approvedPreviewId: string | null;
  createdAt: number;
}

export interface Issue {
  id: string;
  accountId: string;
  scheduleKey: string;
  sunday: number;
  kind: StructuredIssue['kind'];
  prefsVersion: number;
  snapshotId: string;
  cutoff: number;
  windowFrom: number;
  subject: string;
  structured: StructuredIssue;
  html: string;
  text: string;
  status: 'queued' | 'accepted' | 'delivered' | 'failed' | 'bounced' | 'suppressed';
  providerMessageId: string | null;
  attempts: number;
  credit: 'trial' | 'paid' | 'none';
  createdAt: number;
  updatedAt: number;
}

export interface MagicLink { tokenHash: string; email: string; purpose: 'signup' | 'login'; payload: any; expiresAt: number; usedAt: number | null; createdAt: number }
export interface ObservationState { adapter: string; recordId: string; contentHash: string; facts: ObservationFacts; lastObservationId: string }
export interface AdapterRun { adapter: string; at: number; ok: boolean; count: number; error: string | null }
export interface AuditEntry { at: number; actor: string; op: string; detail: string }
export interface Job { id: string; type: string; key: string; payload: any; runAt: number; attempts: number; status: 'queued' | 'running' | 'done' | 'dead'; lastError: string | null }
export interface WaitlistEntry { id: string; email: string; area: string; consentAt: number; createdAt: number }
export interface Snapshot { id: string; at: number; changeIds: string[] }

export interface Store {
  // drafts and previews
  saveDraft(d: Draft): Promise<void>;
  getDraftByToken(tokenHash: string): Promise<Draft | null>;
  getDraft(id: string): Promise<Draft | null>;
  deleteExpiredDrafts(now: number): Promise<number>;
  savePreview(p: Preview): Promise<void>;
  getPreview(id: string): Promise<Preview | null>;
  findReadyPreview(ownerId: string, prefsKey: string, snapshotId: string): Promise<Preview | null>;
  countPreviews(ownerId: string): Promise<number>;
  addWaitlist(w: WaitlistEntry): Promise<void>;

  // accounts, auth
  saveAccount(a: Account): Promise<void>;
  getAccount(id: string): Promise<Account | null>;
  getAccountByEmail(email: string): Promise<Account | null>;
  listAccounts(): Promise<Account[]>;
  deleteAccount(id: string): Promise<void>;
  saveMagicLink(m: MagicLink): Promise<void>;
  /** Atomically mark a link used. Returns the link only if it was unused and unexpired. */
  consumeMagicLink(tokenHash: string, now: number): Promise<MagicLink | null>;
  countMagicLinks(email: string, since: number): Promise<number>;

  // evidence and changes
  getObservationState(adapter: string, recordId: string): Promise<ObservationState | null>;
  saveObservation(o: SourceObservation, state: ObservationState): Promise<void>;
  getObservations(ids: string[]): Promise<SourceObservation[]>;
  listEntities(): Promise<Entity[]>;
  saveEntity(e: Entity): Promise<void>;
  saveChange(c: ChangeEvent): Promise<boolean>;
  getChange(id: string): Promise<ChangeEvent | null>;
  listChanges(filter?: { review?: ChangeEvent['review']; since?: number; field?: 'approvedAt' | 'observedAt' }): Promise<ChangeEvent[]>;
  saveSnapshot(s: Snapshot): Promise<void>;

  // issues and credits
  getIssueByKey(accountId: string, scheduleKey: string): Promise<Issue | null>;
  getIssueByMessageId(messageId: string): Promise<Issue | null>;
  saveIssue(i: Issue): Promise<void>;
  listIssues(accountId: string): Promise<Issue[]>;
  /** Unique on (accountId, issueKey). Returns false if already consumed. */
  consumeCredit(accountId: string, e: LedgerEntry): Promise<boolean>;
  restoreCredit(accountId: string, issueKey: string, at: number): Promise<void>;
  listLedger(accountId: string): Promise<LedgerEntry[]>;

  // billing
  getBilling(accountId: string): Promise<BillingRecord | null>;
  saveBilling(accountId: string, b: BillingRecord): Promise<void>;
  findAccountIdByCustomer(customerId: string): Promise<string | null>;

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
