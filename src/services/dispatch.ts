/** Weekly snapshot, issue generation, dispatch and delivery reconciliation. */
import type { App } from '../app.ts';
import type { Account, Issue } from '../store/types.ts';
import type { DeliveryEvent } from '../domain/ledger.ts';
import { creditEffect, dispatchCheck, suppressesFutureSends, trialUsed, TRIAL_ISSUES } from '../domain/ledger.ts';
import { buildContent } from '../domain/eligibility.ts';
import { renderHtml, renderText, subjectFor } from '../domain/issue.ts';
import { cutoffFor, DAY, localDateKey, nextSunday } from '../domain/time.ts';
import { newId } from '../lib/crypto.ts';
import { accountLike, unsubscribeToken } from './accounts.ts';
import { currentSnapshot, downFamilies, structure } from './onboarding.ts';

/** A broad outage: more than half of the adapters failed their most recent run before the cutoff. */
export async function broadOutage(app: App, cutoff: number): Promise<boolean> {
  const runs = await app.store.listAdapterRuns(500);
  const latest = app.registry.adapters.map((a) => runs.find((r) => r.adapter === a.id && r.at <= cutoff && r.at > cutoff - 2 * DAY)).filter(Boolean);
  if (!latest.length) return false;
  return latest.filter((r) => !r!.ok).length > latest.length / 2;
}

export interface DispatchResult { accountId: string; key: string; outcome: string }

/** Run every Sunday that has come due since the last run (idempotent by account + issue key). */
export async function runDueSundays(app: App): Promise<DispatchResult[]> {
  const now = app.clock.now();
  const last = (await app.store.kvGet<number>('dispatch:last')) ?? now - 1;
  const out: DispatchResult[] = [];
  let s = nextSunday(last, app.cfg.tz);
  while (s <= now) {
    out.push(...(await dispatchSunday(app, s)));
    await app.store.kvSet('dispatch:last', s);
    s = nextSunday(s, app.cfg.tz);
  }
  return out;
}

export async function dispatchSunday(app: App, sunday: number): Promise<DispatchResult[]> {
  const cutoff = cutoffFor(sunday, app.cfg.tz);
  const outage = await broadOutage(app, cutoff);
  const snap = await currentSnapshot(app);
  await app.store.saveSnapshot({ id: `${snap.id}_${localDateKey(sunday, app.cfg.tz)}`, at: cutoff, changeIds: snap.changes.filter((c) => (c.approvedAt ?? 0) <= cutoff).map((c) => c.id) });
  const results: DispatchResult[] = [];
  for (const a of await app.store.listAccounts()) {
    try { results.push(await dispatchAccount(app, a, sunday, { outage })); }
    catch (e) { app.log('dispatch.error', { account: a.id, error: (e as Error).message.slice(0, 200) }); results.push({ accountId: a.id, key: localDateKey(sunday, a.tz), outcome: 'error' }); }
  }
  app.log('dispatch.sunday', { key: localDateKey(sunday, app.cfg.tz), accounts: results.length, sent: results.filter((r) => r.outcome === 'sent').length, outage });
  return results;
}

export async function dispatchAccount(app: App, a0: Account, sunday: number, opts: { outage?: boolean } = {}): Promise<DispatchResult> {
  const key = localDateKey(sunday, a0.tz);
  // Re-read state immediately before sending: consent, suppression and entitlement may have changed.
  const a = (await app.store.getAccount(a0.id))!;
  const al = await accountLike(app, a);
  const decision = dispatchCheck(al, sunday, key);
  const existing = await app.store.getIssueByKey(a.id, key);
  if (existing && ['accepted', 'delivered', 'bounced'].includes(existing.status)) return { accountId: a.id, key, outcome: `skipped: already ${existing.status}` };
  if (!decision.ok) return { accountId: a.id, key, outcome: `skipped: ${decision.reason}` };
  const cutoff = cutoffFor(sunday, a.tz);
  const now = app.clock.now();

  if (opts.outage) {
    const nkey = `${key}:notice`;
    if (await app.store.getIssueByKey(a.id, nkey)) return { accountId: a.id, key: nkey, outcome: 'skipped: notice already sent' };
    const { issue: st } = await structure(app, 'weekly', { main: [], briefs: [], total: 0 }, [], a.prefs, a.lastCutoff, cutoff, []);
    st.kind = 'notice';
    const links = linksFor(app, a, 'This notice does not use a free issue.');
    const issue: Issue = { id: newId('iss'), accountId: a.id, scheduleKey: nkey, sunday, kind: 'notice', prefsVersion: a.prefsVersion, snapshotId: 'none', cutoff, windowFrom: a.lastCutoff, subject: subjectFor(st, sunday), structured: st, html: renderHtml(st, links, a.prefs.len), text: renderText(st, links), status: 'queued', providerMessageId: null, attempts: 0, credit: 'none', createdAt: now, updatedAt: now };
    await send(app, a, issue, links);
    return { accountId: a.id, key: nkey, outcome: 'notice' };
  }

  const snap = await currentSnapshot(app);
  const down = await downFamilies(app);
  const changes = snap.changes.filter((c) => (c.approvedAt ?? 0) <= cutoff);
  const w = { from: a.lastCutoff, to: cutoff, field: 'approvedAt' as const };
  const content = buildContent(changes, a.prefs, w, app.registry.available, down);
  const { issue: st, errors } = await structure(app, 'weekly', content, changes, a.prefs, w.from, w.to, down);
  if (errors.length) {
    app.log('dispatch.validation_failed', { account: a.id, key, errors: errors.length });
    await app.store.audit({ at: now, actor: 'system', op: 'issue.blocked', detail: `${a.id} ${key}: ${errors.join('; ').slice(0, 400)}` });
    return { accountId: a.id, key, outcome: 'blocked: citation check failed' };
  }
  const used = trialUsed(al.ledger);
  const note = decision.credit === 'trial'
    ? used + 1 >= TRIAL_ISSUES ? 'This is your last free issue. Choose a plan in your account to keep receiving updates. Nothing is charged automatically.' : `Free issue ${used + 1} of ${TRIAL_ISSUES}.`
    : 'Included in your plan.';
  const links = linksFor(app, a, note);
  const issue: Issue = existing ?? { id: newId('iss'), accountId: a.id, scheduleKey: key, sunday, kind: st.kind, prefsVersion: a.prefsVersion, snapshotId: snap.id, cutoff, windowFrom: w.from, subject: subjectFor(st, sunday), structured: st, html: renderHtml(st, links, a.prefs.len), text: renderText(st, links), status: 'queued', providerMessageId: null, attempts: 0, credit: decision.credit, createdAt: now, updatedAt: now };
  const ok = await send(app, a, issue, links);
  if (ok) {
    a.lastCutoff = Math.max(a.lastCutoff, cutoff);
    await app.store.saveAccount(a);
  }
  return { accountId: a.id, key, outcome: ok ? 'sent' : 'failed' };
}

function linksFor(app: App, a: Account, footerNote: string) {
  const t = encodeURIComponent(unsubscribeToken(app, a.id));
  return { preferences: `${app.cfg.baseUrl}/account`, unsubscribe: `${app.cfg.baseUrl}/u/${t}`, useful: { yes: `${app.cfg.baseUrl}/useful/${t}?v=yes`, no: `${app.cfg.baseUrl}/useful/${t}?v=no` }, footerNote };
}

async function send(app: App, a: Account, issue: Issue, links: ReturnType<typeof linksFor>): Promise<boolean> {
  issue.attempts++;
  issue.updatedAt = app.clock.now();
  try {
    const r = await app.mailer.send({
      to: a.email, subject: issue.subject, html: issue.html, text: issue.text, tag: issue.kind === 'notice' ? 'notice' : 'issue',
      headers: { 'List-Unsubscribe': `<${links.unsubscribe}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    });
    issue.status = 'accepted';
    issue.providerMessageId = r.id;
    await app.store.saveIssue(issue);
    await reconcileDelivery(app, r.id, 'accepted');
    return true;
  } catch (e) {
    issue.status = 'failed';
    await app.store.saveIssue(issue);
    app.log('dispatch.send_failed', { account: a.id, key: issue.scheduleKey, error: (e as Error).message.slice(0, 200) });
    return false;
  }
}

/** Apply a provider delivery event: credits count once, on final delivery (or acceptance, if configured). */
export async function reconcileDelivery(app: App, messageId: string, ev: DeliveryEvent): Promise<string> {
  const issue = await app.store.getIssueByMessageId(messageId);
  if (!issue) return 'unknown message';
  const now = app.clock.now();
  const ledger = await app.store.listLedger(issue.accountId);
  const consumed = ledger.some((l) => l.issueKey === issue.scheduleKey && !l.restoredAt);
  const countable = issue.credit !== 'none' && issue.kind !== 'notice';
  const effect = countable ? creditEffect(app.cfg.creditMode, ev, consumed) : 'none';
  if (effect === 'consume') await app.store.consumeCredit(issue.accountId, { issueKey: issue.scheduleKey, creditType: issue.credit as 'trial' | 'paid', consumedAt: now });
  if (effect === 'restore') await app.store.restoreCredit(issue.accountId, issue.scheduleKey, now);
  if (ev === 'delivered') issue.status = 'delivered';
  if (ev === 'bounced_hard' || ev === 'failed') issue.status = ev === 'failed' ? 'failed' : 'bounced';
  issue.updatedAt = now;
  await app.store.saveIssue(issue);
  if (suppressesFutureSends(ev)) {
    const a = await app.store.getAccount(issue.accountId);
    if (a && a.emailState !== 'suppressed') {
      a.emailState = 'suppressed';
      await app.store.saveAccount(a);
      await app.store.audit({ at: now, actor: 'email-provider', op: `email.${ev}`, detail: `${a.id}: future sends suppressed` });
    }
  }
  return effect;
}
