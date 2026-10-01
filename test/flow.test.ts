/**
 * Service-level end-to-end flow on fixtures:
 * preview → refinement → verification → three issues → trial exhausted → paid activation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';
import { buildApp, FIXTURE_WEBHOOK_SECRET } from '../src/bootstrap.ts';
import { ConsoleMailer, signSvix } from '../src/providers/email.ts';
import { FakeBilling, signStripe } from '../src/providers/billing.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { refreshAll, reviewChange } from '../src/services/pipeline.ts';
import * as ob from '../src/services/onboarding.ts';
import * as acc from '../src/services/accounts.ts';
import { dispatchSunday, reconcileDelivery } from '../src/services/dispatch.ts';
import { DAY, localDateKey, nextSunday, sundaysBetween } from '../src/domain/time.ts';
import { prefsKey } from '../src/domain/prefs.ts';

async function setup() {
  const store = new MemoryStore();
  const mailer = new ConsoleMailer();
  const billing = new FakeBilling(FIXTURE_WEBHOOK_SECRET);
  const app = await buildApp(loadConfig({ NEARBY_MODE: 'fixture' }), { store, mailer, billing, quiet: true });
  return { app, store, mailer, billing };
}
const linkToken = (m: ConsoleMailer) => decodeURIComponent(m.outbox[0].text.match(/token=([^\s]+)/)![1]);
const stripeEvent = (id: string, type: string, created: number, object: any) => JSON.stringify({ id, type, created, data: { object } });

test('full fixture journey', async () => {
  const { app, store, mailer, billing } = await setup();
  const runs = await refreshAll(app);
  assert.ok(Object.values(runs).every((r) => r.ok));
  const changes = await store.listChanges();
  assert.ok(changes.length > 15);
  const review = changes.filter((c) => c.review === 'needs_review');
  assert.ok(review.some((c) => c.reviewReasons.includes('No confirmed location')), 'unlocated record held');
  assert.ok(review.some((c) => c.reviewReasons.includes('Conflicting evidence')), 'conflicting dates held');
  assert.ok(review.some((c) => c.reviewReasons.some((r) => r.startsWith('Possible duplicate'))), 'different suites flagged');
  assert.ok(changes.some((c) => c.type === 'timeline' && c.before && c.after), 'opening delay detected with before/after');
  assert.ok(changes.some((c) => c.type === 'status' && c.after?.startsWith('Amended')), 'zoning amendment detected');
  assert.ok(changes.every((c) => c.type !== 'closure' || c.name !== 'Corner Florist'));

  // Location: ambiguous, outside coverage, then a real match.
  const { draft, token } = await ob.createDraft(app);
  const amb = await ob.searchAddress(app, draft, 'Main Street');
  assert.equal(amb.length, 2);
  assert.equal((await ob.confirmLocation(app, draft, amb.find((c) => !c.covered)!.id)).covered, false);
  const c = await ob.searchAddress(app, draft, '100 Sample Street');
  assert.equal((await ob.confirmLocation(app, draft, c[0].id)).covered, true);
  const d = (await ob.loadDraft(app, token))!;
  assert.equal(d.prefs!.areaName, 'Lower Greenville');

  // Zero categories blocks; unavailable sources need acknowledgement under deep research.
  assert.match(ob.previewBlockers(app, { ...d, prefs: { ...d.prefs!, cats: [] } })[0], /at least one/);
  const deep = { ...d, prefs: { ...d.prefs!, preset: 'deep' as const, fams: Object.fromEntries(Object.keys(d.prefs!.fams).map((k) => [k, true])) } };
  assert.ok(ob.previewBlockers(app, deep).some((b) => b.includes('available sources')));

  // Area: text becomes proposals; nothing applies until confirmed.
  await ob.proposeFromText(app, d, 'Include Knox Henderson, but exclude everything north of Mockingbird');
  assert.equal(d.proposals.length, 2);
  assert.equal(d.prefs!.inc.length + d.prefs!.exc.length, 0);
  assert.ok(ob.previewBlockers(app, d).some((b) => b.includes('proposed')));
  for (const p of [...d.proposals]) await ob.resolveProposal(app, d, p.id, true);
  assert.equal(d.prefs!.inc.length, 1);
  assert.equal(d.prefs!.exc.length, 1);
  await ob.proposeFromText(app, d, 'exclude Greenville Ave');
  assert.ok(d.clarify, 'bare street asks which stretch');
  d.clarify = null;
  await ob.proposeSegment(app, d, 'exclude', 'Greenville Ave', 'Ross Ave', 'Belmont Ave', 150);
  assert.equal(d.proposals[0].shape.kind, 'corridor');
  await ob.resolveProposal(app, d, d.proposals[0].id, false);
  d.prefs!.areaMode = 'radius';
  assert.ok(ob.previewBlockers(app, d).some((b) => b.includes('available sources')), 'balanced research includes an unavailable family');
  d.ack = true;
  await ob.setPrefs(app, d, d.prefs!);

  // Preview: grounded, labeled, no address in heading; cached when unchanged.
  const pv1 = await ob.startPreview(app, d, 'ip1', { sync: true });
  const p1 = (await store.getPreview(pv1.id))!;
  assert.equal(p1.status, 'ready');
  assert.ok(p1.content!.main.length >= 4, `items: ${p1.content!.main.length}`);
  for (const it of p1.issue!.items) {
    assert.ok(it.sources.length && it.sources.every((s) => s.url.startsWith('https://')), 'evidence');
    assert.ok(it.evidenceLabel);
  }
  assert.ok(!JSON.stringify(p1.issue).includes('100 Sample Street'), 'no home address in issue');
  assert.ok(!p1.issue!.items.some((i) => i.name.startsWith('Unnamed taqueria')), 'unlocated never shown');
  assert.ok(!p1.issue!.items.some((i) => i.name === 'Brickhouse Bakery' && i.date), 'conflicting dates held until review');
  assert.ok(!p1.issue!.items.some((i) => i.type === 'reminder'), 'no reminder when the announcement itself is in the issue');
  const tide = [...p1.issue!.items, ...p1.issue!.briefs].find((i) => i.name === 'Tidewater Salon');
  assert.equal(tide?.evidenceLabel, 'Early signal');
  const again = await ob.startPreview(app, d, 'ip1', { sync: true });
  assert.equal(again.id, pv1.id, 'cached preview reused');
  assert.equal(d.gens, 1, 'cache does not use budget');

  // Approve, refine (invalidates approval), regenerate, approve the new version.
  await ob.approvePreview(app, d, pv1.id);
  const plan = await ob.planRefinement(app, d.prefs!, 'Less detail');
  assert.deepEqual(plan.diff.map((r) => r[0]), ['Length']);
  await ob.applyRefinement(app, d, plan.ops);
  assert.equal(await ob.approvedPreview(app, d), null, 'change invalidates approval');
  await assert.rejects(ob.approvePreview(app, d, pv1.id), /settings changed/);
  const pv2 = await ob.startPreview(app, d, 'ip1', { sync: true });
  assert.equal((await store.getPreview(pv2.id))!.content!.main.length, 4, 'brief length');
  await ob.approvePreview(app, d, pv2.id);

  // Signup requires consent; verification creates the account bound to the approved version.
  const bad = await acc.requestSignup(app, d, { email: 'not-an-email', consent: false, marketing: false });
  assert.equal(bad.ok, false);
  const ok = await acc.requestSignup(app, d, { email: 'Pilot@Example.com', consent: true, marketing: false });
  assert.equal(ok.ok, true);
  const tok = linkToken(mailer);
  const v = await acc.verifyLink(app, tok);
  assert.ok('accountId' in v);
  assert.ok('error' in (await acc.verifyLink(app, tok)), 'magic link is single use');
  const a = (await store.getAccount((v as any).accountId))!;
  assert.equal(prefsKey(a.prefs), (await store.getPreview(pv2.id))!.prefsKey);
  assert.equal(a.email, 'pilot@example.com');

  // Weekly sends: credits count once on delivery; retries and failures don't double count.
  const sundays: number[] = [];
  let s = a.firstIssueAt;
  for (let i = 0; i < 6; i++) { sundays.push(s); s = nextSunday(s); }
  app.clock.offset = sundays[0] - Date.now() + 60_000;
  await refreshAll(app);
  let r = await dispatchSunday(app, sundays[0]);
  assert.equal(r[0].outcome, 'sent');
  const iss1 = (await store.getIssueByKey(a.id, localDateKey(sundays[0])))!;
  assert.equal((await store.listLedger(a.id)).length, 0, 'accepted is not delivered');
  assert.equal(await reconcileDelivery(app, iss1.providerMessageId!, 'delivered'), 'consume');
  assert.equal(await reconcileDelivery(app, iss1.providerMessageId!, 'delivered'), 'none', 'duplicate delivery event');
  r = await dispatchSunday(app, sundays[0]);
  assert.match(r[0].outcome, /already/);
  assert.ok(!iss1.html.includes('100 Sample Street') && !iss1.subject.includes('Sample Street'));
  assert.ok(iss1.text.includes('Unsubscribe: '));

  // A failed send uses no credit and can be retried under the same key.
  app.clock.offset = sundays[1] - Date.now() + 60_000;
  await refreshAll(app);
  const realSend = mailer.send.bind(mailer);
  mailer.send = async () => { throw new Error('provider down'); };
  r = await dispatchSunday(app, sundays[1]);
  assert.equal(r[0].outcome, 'failed');
  mailer.send = realSend;
  r = await dispatchSunday(app, sundays[1]);
  assert.equal(r[0].outcome, 'sent');
  const iss2 = (await store.getIssueByKey(a.id, localDateKey(sundays[1])))!;
  assert.equal(iss2.attempts, 2);
  await reconcileDelivery(app, iss2.providerMessageId!, 'delivered');

  // Broad outage: a notice, no credit.
  app.clock.offset = sundays[2] - Date.now() + 60_000;
  const failingRuns = app.registry.adapters.map((x) => ({ adapter: x.id, at: sundays[2] - DAY - 3600_000, ok: false, count: 0, error: 'down' }));
  for (const fr of failingRuns) await store.recordAdapterRun(fr);
  r = await dispatchSunday(app, sundays[2]);
  assert.equal(r[0].outcome, 'notice');
  const notice = (await store.getIssueByKey(a.id, `${localDateKey(sundays[2])}:notice`))!;
  await reconcileDelivery(app, notice.providerMessageId!, 'delivered');
  assert.equal((await store.listLedger(a.id)).length, 2, 'notice uses no credit');

  // Third issue; then sends pause without any charge.
  app.clock.offset = sundays[3] - Date.now() + 60_000;
  await refreshAll(app);
  r = await dispatchSunday(app, sundays[3]);
  const iss3 = (await store.getIssueByKey(a.id, localDateKey(sundays[3])))!;
  assert.ok(iss3.text.includes('last free issue'));
  await reconcileDelivery(app, iss3.providerMessageId!, 'delivered');
  let dash = await acc.dashboard(app, (await store.getAccount(a.id))!);
  assert.equal(dash.state, 'trial_exhausted');
  assert.equal(dash.left, 0);
  r = await dispatchSunday(app, sundays[4]);
  assert.match(r[0].outcome, /no free issues left/);

  // Checkout: the redirect alone does not grant access; a signed webhook does. Duplicates are safe.
  const acct = (await store.getAccount(a.id))!;
  await acc.startCheckout(app, acct, 'monthly');
  await acc.checkoutReturned(app, acct, 'monthly');
  dash = await acc.dashboard(app, (await store.getAccount(a.id))!);
  assert.equal(dash.state, 'checkout_pending');
  assert.equal(r.length, 1);
  const nowSec = Math.floor(Date.now() / 1000);
  const start = app.clock.now(), end = start + 31 * DAY;
  const subObj = { id: 'sub_1', customer: 'cus_1', status: 'active', cancel_at_period_end: false, metadata: { account_id: a.id }, current_period_start: Math.floor(start / 1000), current_period_end: Math.floor(end / 1000), items: { data: [{ price: { id: 'price_test_monthly', recurring: { interval: 'month' } } }] } };
  const unsigned = stripeEvent('evt_x', 'customer.subscription.created', nowSec, subObj);
  assert.equal((await acc.handleBillingWebhook(app, unsigned, 'bad')).status, 400);
  const invoice = stripeEvent('evt_inv', 'invoice.paid', nowSec, { subscription: 'sub_1', customer: 'cus_1', parent: { subscription_details: { metadata: { account_id: a.id } } } });
  assert.match((await acc.handleBillingWebhook(app, invoice, signStripe(invoice, FIXTURE_WEBHOOK_SECRET, nowSec))).note, /held/);
  const created = stripeEvent('evt_sub', 'customer.subscription.created', nowSec, subObj);
  await acc.handleBillingWebhook(app, created, signStripe(created, FIXTURE_WEBHOOK_SECRET, nowSec));
  assert.match((await acc.handleBillingWebhook(app, created, signStripe(created, FIXTURE_WEBHOOK_SECRET, nowSec))).note, /Duplicate/);
  dash = await acc.dashboard(app, (await store.getAccount(a.id))!);
  assert.equal(dash.state, 'paid_active');
  assert.equal(billing.sessions.length, 1);
  const paidSundays = sundaysBetween(start, end);
  for (const ps of paidSundays) {
    const res = await dispatchSunday(app, ps);
    assert.equal(res[0].outcome, 'sent', `paid Sunday ${localDateKey(ps)}`);
  }

  // Unsubscribe stops sends but not billing; cancellation keeps term access.
  await acc.unsubscribe(app, a.id, 'test');
  r = await dispatchSunday(app, nextSunday(end));
  assert.match(r[0].outcome, /email email_unsubscribed/);
  assert.equal((await acc.dashboard(app, (await store.getAccount(a.id))!)).state, 'paid_active');

  // Hard bounce suppresses future sends.
  const acct2 = (await store.getAccount(a.id))!;
  await acc.resubscribe(app, acct2, true);
  const last = (await store.listIssues(a.id)).filter((i) => i.status === 'accepted').pop()!;
  await reconcileDelivery(app, last.providerMessageId!, 'bounced_hard');
  assert.equal((await store.getAccount(a.id))!.emailState, 'suppressed');

  // Deletion removes the account and archive.
  await acc.deleteAccount(app, (await store.getAccount(a.id))!);
  assert.equal(await store.getAccount(a.id), null);
  assert.equal((await store.listIssues(a.id)).length, 0);
});

test('operator approval makes a held change eligible in the next issue', async () => {
  const { app, store } = await setup();
  await refreshAll(app);
  const held = (await store.listChanges({ review: 'needs_review' })).find((c) => c.name === 'Brickhouse Bakery')!;
  await reviewChange(app, held.id, 'approved', 'op@example.com');
  const after = (await store.getChange(held.id))!;
  assert.equal(after.review, 'approved');
  assert.ok(after.approvedAt! >= app.clock.now() - 1000);
  assert.ok((await store.listAudit()).some((e) => e.op === 'change.approve'));
  const unloc = (await store.listChanges({ review: 'needs_review' })).find((c) => !c.geom)!;
  await assert.rejects(reviewChange(app, unloc.id, 'approved', 'op'), /location/);
});

test('webhook with a stale timestamp is rejected', async () => {
  const { app } = await setup();
  const body = stripeEvent('evt_old', 'invoice.paid', 1, {});
  assert.equal((await acc.handleBillingWebhook(app, body, signStripe(body, FIXTURE_WEBHOOK_SECRET, 1_000))).status, 400);
  assert.ok(signSvix('{}', 'whsec_' + Buffer.from('k').toString('base64'), 'id', 1)['svix-signature'].startsWith('v1,'));
});
