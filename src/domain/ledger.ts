/**
 * Trial ledger and dispatch entitlement. Billing state and email state are separate fields.
 */
import { DAY } from './time.ts';

export const TRIAL_ISSUES = 3;
export type BillingState = 'trial_active' | 'trial_exhausted' | 'checkout_pending' | 'paid_active' | 'past_due' | 'canceled_pending_expiry' | 'expired';
export type EmailState = 'active' | 'email_unsubscribed' | 'suppressed';
export type SubStatus = 'pending' | 'active' | 'past_due' | 'canceled_pending_expiry' | 'expired';

export interface LedgerEntry { issueKey: string; creditType: 'trial' | 'paid'; consumedAt: number; restoredAt?: number | null }
export interface SubInfo { status: SubStatus; plan: 'monthly' | 'annual' | null; termStart: number | null; termEnd: number | null; cancelAtEnd: boolean }

export interface AccountLike {
  verifiedAt: number | null;
  consentAt: number | null;
  emailState: EmailState;
  paused: boolean;
  firstIssueAt: number;
  checkoutPending: boolean;
  ledger: LedgerEntry[];
  sub: SubInfo | null;
}

export const trialUsed = (ledger: LedgerEntry[]) => ledger.filter((l) => l.creditType === 'trial' && !l.restoredAt).length;

export function paidCovers(sub: SubInfo | null, at: number): boolean {
  return !!sub && ['active', 'past_due', 'canceled_pending_expiry'].includes(sub.status)
    && sub.termStart != null && sub.termEnd != null && at >= sub.termStart && at < sub.termEnd;
}

export function billingState(a: AccountLike, now: number): BillingState {
  const s = a.sub;
  if (s && paidCovers(s, now)) return s.status === 'past_due' ? 'past_due' : s.status === 'canceled_pending_expiry' ? 'canceled_pending_expiry' : 'paid_active';
  if (a.checkoutPending) return 'checkout_pending';
  if (s && (s.status === 'expired' || (s.termEnd != null && now >= s.termEnd))) return 'expired';
  return trialUsed(a.ledger) < TRIAL_ISSUES ? 'trial_active' : 'trial_exhausted';
}

/** Which credit a send on `sunday` would use, or null when nothing entitles it. Paid coverage wins over remaining trial credits. */
export function entitlementFor(a: AccountLike, sunday: number): 'trial' | 'paid' | null {
  if (paidCovers(a.sub, sunday)) return 'paid';
  if (trialUsed(a.ledger) < TRIAL_ISSUES) return 'trial';
  return null;
}

export type DispatchDecision = { ok: true; credit: 'trial' | 'paid' } | { ok: false; reason: string };

/** Re-run immediately before every send, not only when the job is created. */
export function dispatchCheck(a: AccountLike, sunday: number, issueKey: string): DispatchDecision {
  if (!a.verifiedAt) return { ok: false, reason: 'email not verified' };
  if (!a.consentAt) return { ok: false, reason: 'no newsletter consent' };
  if (a.emailState !== 'active') return { ok: false, reason: `email ${a.emailState}` };
  if (a.paused) return { ok: false, reason: 'delivery paused' };
  if (sunday < a.firstIssueAt) return { ok: false, reason: 'before first scheduled issue' };
  const done = a.ledger.find((l) => l.issueKey === issueKey && !l.restoredAt);
  if (done) return { ok: false, reason: 'issue already delivered' };
  const e = entitlementFor(a, sunday);
  if (!e) return { ok: false, reason: 'no free issues left and no active plan' };
  return { ok: true, credit: e };
}

export type CreditMode = 'delivery' | 'acceptance';
export type DeliveryEvent = 'accepted' | 'delivered' | 'bounced_hard' | 'bounced_soft' | 'complained' | 'failed';

/** Ledger effect of a provider delivery event. Idempotency comes from the unique issue key. */
export function creditEffect(mode: CreditMode, ev: DeliveryEvent, alreadyConsumed: boolean): 'consume' | 'restore' | 'none' {
  if (mode === 'delivery') {
    if (ev === 'delivered' && !alreadyConsumed) return 'consume';
    return 'none';
  }
  if (ev === 'accepted' && !alreadyConsumed) return 'consume';
  if (ev === 'bounced_hard' && alreadyConsumed) return 'restore';
  return 'none';
}

export const suppressesFutureSends = (ev: DeliveryEvent) => ev === 'bounced_hard' || ev === 'complained';

/** Anonymous preview budget. */
export const PREVIEW_LIMITS = { perDraft: 3, perDay: 5, window: DAY };
