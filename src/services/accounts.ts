/** Signup, sign-in, account settings, billing and unsubscribe. */
import type { App } from '../app.ts';
import type { Account } from '../store/types.ts';
import type { Draft } from '../store/types.ts';
import type { AccountLike, SubInfo } from '../domain/ledger.ts';
import { billingState, entitlementFor, TRIAL_ISSUES, trialUsed } from '../domain/ledger.ts';
import { applyStripeEvent, emptyBilling } from '../domain/billing.ts';
import { applyOps, diffPrefs, validatePrefs } from '../domain/prefs.ts';
import type { PrefOp } from '../domain/prefs.ts';
import { DAY, firstIssueAfter, fmtDate, fmtDateTime, MIN, sundaysBetween } from '../domain/time.ts';
import { newId, randomToken, sha256, signValue, verifyValue } from '../lib/crypto.ts';
import { approvedPreview, UserError } from './onboarding.ts';

export const CONSENT_VERSION = '2026-10-01';
export const MAGIC_TTL = 15 * MIN;
const MAX_LINKS_PER_10_MIN = 3;
const validEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(e) && e.length <= 254;

async function sendLink(app: App, email: string, purpose: 'signup' | 'login', payload: unknown) {
  const now = app.clock.now();
  if ((await app.store.countMagicLinks(email, now - 10 * MIN)) >= MAX_LINKS_PER_10_MIN) throw new UserError('Too many sign-in links were sent. Wait 10 minutes and try again.');
  const token = randomToken();
  await app.store.saveMagicLink({ tokenHash: sha256(token), email, purpose, payload, expiresAt: now + MAGIC_TTL, usedAt: null, createdAt: now });
  const url = `${app.cfg.baseUrl}/auth/verify?token=${encodeURIComponent(token)}`;
  const intro = purpose === 'signup' ? 'Confirm your email to start your 3 free weekly issues from Nearby.' : 'Use this link to sign in to Nearby.';
  await app.mailer.send({
    to: email, tag: 'magic_link', subject: purpose === 'signup' ? 'Confirm your email for Nearby' : 'Your Nearby sign-in link',
    text: `${intro}\n\n${url}\n\nThe link works once and expires in 15 minutes. If you didn't request it, ignore this email.`,
    html: `<p>${intro}</p><p><a href="${url}">${purpose === 'signup' ? 'Confirm my email' : 'Sign in'}</a></p><p style="color:#56655E;font-size:13px">The link works once and expires in 15 minutes. If you didn't request it, ignore this email.</p>`,
  });
}

export async function requestSignup(app: App, d: Draft, o: { email: string; consent: boolean; marketing: boolean }) {
  const email = o.email.trim().toLowerCase();
  const errors: Record<string, string> = {};
  if (!validEmail(email)) errors.email = 'Enter a valid email address, like name@example.com.';
  if (!o.consent) errors.consent = 'Tick the box to agree to receive the weekly newsletter.';
  if (Object.keys(errors).length) return { ok: false as const, errors };
  const pv = await approvedPreview(app, d);
  if (!pv) throw new UserError('Approve a sample that matches your current settings first.');
  const existing = await app.store.getAccountByEmail(email);
  // An existing verified account gets a sign-in link; its free-issue credits are not reset.
  await sendLink(app, email, existing?.verifiedAt ? 'login' : 'signup', { draftId: d.id, previewId: pv.id, consentAt: app.clock.now(), consentVersion: CONSENT_VERSION, marketing: o.marketing });
  return { ok: true as const, firstIssueAt: firstIssueAfter(app.clock.now(), app.cfg.tz) };
}

export async function requestLogin(app: App, emailRaw: string) {
  const email = emailRaw.trim().toLowerCase();
  if (!validEmail(email)) throw new UserError('Enter a valid email address.');
  const a = await app.store.getAccountByEmail(email);
  if (a?.verifiedAt) await sendLink(app, email, 'login', {});
  // Same response either way, so the form does not reveal who has an account.
}

/** Consume a magic link. Returns the account id to sign in, or an error message. */
export async function requestOperatorLogin(app: App, emailRaw: string) {
  const email = emailRaw.trim().toLowerCase();
  if (app.cfg.operatorEmails.includes(email)) await sendLink(app, email, 'login', { operator: true });
}

export async function verifyLink(app: App, token: string): Promise<{ accountId: string; created: boolean } | { operatorEmail: string } | { error: string }> {
  const now = app.clock.now();
  const m = await app.store.consumeMagicLink(sha256(token), now);
  if (!m) return { error: 'This link has expired or was already used. Request a new one.' };
  if (m.payload?.operator) return app.cfg.operatorEmails.includes(m.email) ? { operatorEmail: m.email } : { error: 'This address is not an operator.' };
  let a = await app.store.getAccountByEmail(m.email);
  if (m.purpose === 'login' && a) return { accountId: a.id, created: false };
  const d = m.payload?.draftId ? await app.store.getDraft(m.payload.draftId) : null;
  const pv = d ? await approvedPreview(app, d) : null;
  if (!pv || pv.id !== m.payload.previewId) return { error: 'Your approved sample changed or expired. Start again to approve a new sample.' };
  if (!a) {
    a = {
      id: newId('acct'), email: m.email, verifiedAt: now, tz: app.cfg.tz, consentVersion: m.payload.consentVersion, consentAt: m.payload.consentAt,
      marketingConsent: !!m.payload.marketing, emailState: 'active', paused: false, firstIssueAt: firstIssueAfter(now, app.cfg.tz),
      lastCutoff: pv.periodTo, checkoutPending: false, checkoutPlan: null, prefs: structuredClone(pv.prefs), prefsVersion: 1, approvedPreviewId: pv.id, createdAt: now,
    };
  } else {
    // Re-verifying an existing account applies the newly approved settings; credits stay as they were.
    Object.assign(a, { verifiedAt: a.verifiedAt ?? now, consentAt: m.payload.consentAt, consentVersion: m.payload.consentVersion, prefs: structuredClone(pv.prefs), prefsVersion: a.prefsVersion + 1, approvedPreviewId: pv.id });
  }
  await app.store.saveAccount(a);
  pv.accountId = a.id;
  await app.store.savePreview(pv);
  await app.store.audit({ at: now, actor: 'subscriber', op: 'consent.newsletter', detail: `${a.id} consent v${a.consentVersion}${a.marketingConsent ? ' + marketing' : ''}` });
  return { accountId: a.id, created: true };
}

/* ---------- sessions ---------- */
export const SESSION_TTL = 30 * DAY;
export const makeSession = (app: App, accountId: string) => signValue({ a: accountId, iat: Date.now() }, app.cfg.sessionSecret);
export function readSession(app: App, cookie: string | undefined): string | null {
  const v = verifyValue<{ a: string; iat: number }>(cookie, app.cfg.sessionSecret);
  return v && Date.now() - v.iat < SESSION_TTL ? v.a : null;
}
export const unsubscribeToken = (app: App, accountId: string) => signValue({ a: accountId, p: 'unsub' }, app.cfg.sessionSecret);
export function readUnsubscribeToken(app: App, t: string): string | null {
  const v = verifyValue<{ a: string; p: string }>(t, app.cfg.sessionSecret);
  return v?.p === 'unsub' ? v.a : null;
}

/* ---------- account state ---------- */
export async function accountLike(app: App, a: Account): Promise<AccountLike & { sub: SubInfo | null }> {
  const [ledger, billing] = await Promise.all([app.store.listLedger(a.id), app.store.getBilling(a.id)]);
  return { verifiedAt: a.verifiedAt, consentAt: a.consentAt, emailState: a.emailState, paused: a.paused, firstIssueAt: a.firstIssueAt, checkoutPending: a.checkoutPending, ledger, sub: billing?.sub ?? null };
}

export async function dashboard(app: App, a: Account) {
  const now = app.clock.now();
  const al = await accountLike(app, a);
  const state = billingState(al, now);
  const used = trialUsed(al.ledger);
  const upcoming = sundaysBetween(Math.max(now, a.firstIssueAt - DAY), now + 70 * DAY, a.tz).slice(0, 8).map((s) => ({ at: s, ent: a.paused || a.emailState !== 'active' ? null : entitlementFor(al, s) }));
  // Trial entitlements beyond the remaining credits are not actually available.
  let left = TRIAL_ISSUES - used;
  for (const u of upcoming) if (u.ent === 'trial') { if (left > 0) left--; else u.ent = null; }
  const next = upcoming.find((u) => u.ent && u.at >= a.firstIssueAt)?.at ?? null;
  const issues = await app.store.listIssues(a.id);
  const billing = await app.store.getBilling(a.id);
  return { state, used, left: TRIAL_ISSUES - used, next, upcoming, issues, sub: al.sub, billing, ledger: al.ledger };
}

export async function planPrefsEdit(a: Account, ops: PrefOp[]) {
  const next = applyOps(a.prefs, ops);
  return { next, diff: diffPrefs(a.prefs, next), errors: validatePrefs(next) };
}
export async function savePrefsEdit(app: App, a: Account, ops: PrefOp[]) {
  const { next, diff, errors } = await planPrefsEdit(a, ops);
  if (errors.length) throw new UserError(errors[0]);
  if (!diff.length) return a;
  a.prefs = next;
  a.prefsVersion++;
  await app.store.saveAccount(a);
  await app.store.audit({ at: app.clock.now(), actor: 'subscriber', op: 'preferences.update', detail: `${a.id} v${a.prefsVersion}: ${diff.map((r) => r[0]).join(', ')}` });
  return a;
}

export async function setPaused(app: App, a: Account, paused: boolean) { a.paused = paused; await app.store.saveAccount(a); }

export async function unsubscribe(app: App, accountId: string, via: string) {
  const a = await app.store.getAccount(accountId);
  if (!a) return null;
  if (a.emailState === 'active') {
    a.emailState = 'email_unsubscribed';
    await app.store.saveAccount(a);
    await app.store.audit({ at: app.clock.now(), actor: 'subscriber', op: 'email.unsubscribe', detail: `${a.id} via ${via}` });
  }
  return a;
}
export async function resubscribe(app: App, a: Account, consent: boolean) {
  if (!consent) throw new UserError('Tick the box to confirm you want the weekly newsletter again.');
  if (a.emailState === 'suppressed') throw new UserError('Email to this address bounced or was marked as spam, so we can’t send to it. Contact support to change your email.');
  a.emailState = 'active';
  a.consentAt = app.clock.now();
  a.consentVersion = CONSENT_VERSION;
  await app.store.saveAccount(a);
  await app.store.audit({ at: app.clock.now(), actor: 'subscriber', op: 'email.resubscribe', detail: a.id });
}

export async function deleteAccount(app: App, a: Account) {
  const b = await app.store.getBilling(a.id);
  if (b?.subscriptionId && b.sub && b.sub.status !== 'expired' && app.billing) await app.billing.cancelNow(b.subscriptionId);
  await app.store.deleteAccount(a.id);
  await app.store.audit({ at: app.clock.now(), actor: 'subscriber', op: 'account.delete', detail: `${a.id}: personal data removed; ledger and billing records retained` });
}

/* ---------- billing ---------- */
export function checkoutAvailable(app: App): string | null {
  if (!app.billing) return 'Checkout is unavailable because prices have not been configured.';
  return null;
}

export async function startCheckout(app: App, a: Account, plan: 'monthly' | 'annual') {
  const off = checkoutAvailable(app);
  if (off) throw new UserError(off);
  const state = billingState(await accountLike(app, a), app.clock.now());
  if (!['trial_exhausted', 'expired', 'checkout_pending'].includes(state)) throw new UserError('Plans become available after your free issues. Nothing is charged automatically.');
  const b = await app.store.getBilling(a.id);
  const r = await app.billing!.createCheckout({ accountId: a.id, email: a.email, plan, customerId: b?.customerId ?? null, successUrl: `${app.cfg.baseUrl}/account/checkout-return?plan=${plan}`, cancelUrl: `${app.cfg.baseUrl}/account` });
  return r.url;
}

/** The browser returning from checkout only marks the account as waiting. Access comes from a verified webhook. */
export async function checkoutReturned(app: App, a: Account, plan: string) {
  const b = await app.store.getBilling(a.id);
  if (b?.sub && ['active', 'canceled_pending_expiry'].includes(b.sub.status)) return;
  a.checkoutPending = true;
  a.checkoutPlan = plan === 'annual' ? 'annual' : 'monthly';
  await app.store.saveAccount(a);
}

export async function setRenewal(app: App, a: Account, renew: boolean) {
  const b = await app.store.getBilling(a.id);
  if (!b?.subscriptionId || !app.billing) throw new UserError('There is no active plan to change.');
  await app.billing.cancelAtPeriodEnd(b.subscriptionId, !renew);
  await app.store.audit({ at: app.clock.now(), actor: 'subscriber', op: renew ? 'billing.resume_renewal' : 'billing.cancel_renewal', detail: a.id });
}

export async function portalUrl(app: App, a: Account) {
  const b = await app.store.getBilling(a.id);
  if (!b?.customerId || !app.billing) throw new UserError('There is no billing account yet.');
  return (await app.billing.portal({ customerId: b.customerId, returnUrl: `${app.cfg.baseUrl}/account` })).url;
}

export async function handleBillingWebhook(app: App, body: string, signature: string | undefined): Promise<{ status: number; note: string }> {
  if (!app.billing) return { status: 404, note: 'Billing is not configured.' };
  const ev = app.billing.verifyWebhook(body, signature, Date.now());
  if (!ev) return { status: 400, note: 'Invalid signature' };
  const o = ev.data?.object ?? {};
  const accountId = o.metadata?.account_id ?? o.client_reference_id ?? o.subscription_details?.metadata?.account_id ?? o.parent?.subscription_details?.metadata?.account_id
    ?? (o.customer ? await app.store.findAccountIdByCustomer(o.customer) : null);
  if (!accountId) { app.log('billing.unmatched', { type: ev.type, id: ev.id }); return { status: 200, note: 'No matching account' }; }
  const rec = (await app.store.getBilling(accountId)) ?? emptyBilling();
  const r = applyStripeEvent(rec, ev, { monthly: app.cfg.billing.priceMonthly ?? undefined, annual: app.cfg.billing.priceAnnual ?? undefined });
  if (r.changed) {
    await app.store.saveBilling(accountId, r.rec);
    const a = await app.store.getAccount(accountId);
    if (a && r.rec.sub && ['active', 'canceled_pending_expiry', 'past_due', 'expired'].includes(r.rec.sub.status) && a.checkoutPending) {
      a.checkoutPending = false;
      await app.store.saveAccount(a);
    }
    if (a && ev.type === 'invoice.payment_failed' && a.emailState === 'active') await notifyPaymentFailed(app, a, r.rec.sub?.termEnd ?? null);
    await app.store.audit({ at: app.clock.now(), actor: 'billing-provider', op: `billing.${ev.type}`, detail: `${accountId}: ${r.note}` });
  }
  return { status: 200, note: r.note };
}

async function notifyPaymentFailed(app: App, a: Account, termEnd: number | null) {
  const until = termEnd ? ` before ${fmtDate(termEnd, a.tz)}` : '';
  await app.mailer.send({ to: a.email, tag: 'service', subject: 'Your Nearby payment didn’t go through',
    text: `We couldn't process your renewal payment. Update your card in your account${until} to keep receiving weekly issues: ${app.cfg.baseUrl}/account`,
    html: `<p>We couldn't process your renewal payment. Update your card in <a href="${app.cfg.baseUrl}/account">your account</a>${until} to keep receiving weekly issues.</p>` });
}

export const describeTime = (app: App, t: number) => fmtDateTime(t, app.cfg.tz);
