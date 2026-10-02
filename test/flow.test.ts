/** Service-level flow on fixtures: search → report → refine → subscription request → confirm → hand-off. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';
import { buildApp } from '../src/bootstrap.ts';
import { ConsoleMailer } from '../src/providers/email.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { refreshAll } from '../src/services/pipeline.ts';
import * as ob from '../src/services/onboarding.ts';
import * as rep from '../src/services/reports.ts';
import type { Researcher } from '../src/research/types.ts';

async function setup(env: Record<string, string> = {}, researcher?: Researcher | null) {
  const store = new MemoryStore();
  const mailer = new ConsoleMailer();
  const app = await buildApp(loadConfig({ NEARBY_MODE: 'fixture', FIXTURE_STEP_MS: '1', ...env }), { store, mailer, quiet: true, ...(researcher !== undefined ? { researcher } : {}) });
  await refreshAll(app);
  return { app, store, mailer };
}
async function located(app: Awaited<ReturnType<typeof setup>>['app']) {
  const { draft } = await ob.createDraft(app);
  const c = await ob.searchAddress(app, draft, '100 Sample Street');
  await ob.confirmLocation(app, draft, c[0].id);
  draft.ack = true;
  await ob.setPrefs(app, draft, draft.prefs!);
  return draft;
}

test('fixture report: verified, in-area items only; drops are explained', async () => {
  const { app, store } = await setup();
  const d = await located(app);
  const r = await rep.startReport(app, d, 'v1', { sync: true });
  const x = (await store.getReport(r.id))!;
  assert.equal(x.status, 'ready', x.error ?? '');
  assert.ok(x.issue!.items.length >= 6, `items: ${x.issue!.items.length}`);
  assert.ok(x.progress.queries.length >= 2);
  const reasons = Object.fromEntries(x.dropped.map((dd) => [dd.name, dd.reason]));
  assert.equal(reasons['Rumored rooftop bar'], 'no source we could verify');
  assert.equal(reasons['Far-away market'], 'outside your area');
  for (const it of [...x.issue!.items, ...x.issue!.briefs]) {
    assert.ok(it.sources.length && it.sources.every((s) => s.url.startsWith('https://')));
    assert.ok(it.distanceMi <= 1.001, `${it.name} at ${it.distanceMi}`);
  }
  assert.ok(!JSON.stringify(x.issue).includes('100 Sample Street'), 'home address not in the report');
  assert.ok(x.usage && x.usage.costUsd > 0);
  assert.equal(x.issue!.items[0].isEvent, true, 'opening events rank first');
});

test('reuse, refinement and per-draft limits', async () => {
  const { app, store } = await setup({ REPORTS_PER_DRAFT: '2' });
  const d = await located(app);
  const a = await rep.startReport(app, d, 'v1', { sync: true });
  const again = await rep.startReport(app, d, 'v1', { sync: true });
  assert.equal(again.id, a.id, 'unchanged settings reuse the report');
  const plan = await ob.planRefinement(app, d.prefs!, 'Only food');
  assert.deepEqual(plan.diff.map((r) => r[0]), ['Interests']);
  await ob.applyRefinement(app, d, plan.ops);
  const b = await rep.startReport(app, d, 'v1', { sync: true });
  assert.notEqual(b.id, a.id);
  const bx = (await store.getReport(b.id))!;
  assert.ok(bx.issue!.items.every((i) => i.cat === 'food'));
  assert.equal(bx.version, 2);
  await ob.applyRefinement(app, d, [{ k: 'len', v: 'brief' }]);
  await assert.rejects(rep.startReport(app, d, 'v1'), /run 2 reports/);
});

test('visitor and daily limits; failures do not count', async () => {
  let fail = true;
  const flaky: Researcher = { name: 'flaky', async run() { if (fail) throw new Error('upstream exploded'); throw new Error('still'); } };
  const { app, store } = await setup({ REPORTS_PER_VISITOR_PER_DAY: '1' }, flaky);
  const d = await located(app);
  const r = await rep.startReport(app, d, 'v1', { sync: true });
  const x = (await store.getReport(r.id))!;
  assert.equal(x.status, 'failed');
  assert.match(x.error!, /research service had a problem/);
  assert.ok(!x.error!.includes('exploded'), 'internal error text not shown to visitors');
  assert.equal(await rep.reportLimits(app, d, 'v1'), null, 'failed attempt not counted');
  fail = false;
});

test('timeouts end honestly', async () => {
  const slow: Researcher = { name: 'slow', run: (_r, _p, signal) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')))) };
  const { app, store } = await setup({ REPORT_TIMEOUT_SECONDS: '0.05' }, slow);
  const d = await located(app);
  const r = await rep.startReport(app, d, 'v1', { sync: true });
  const x = (await store.getReport(r.id))!;
  assert.equal(x.status, 'timeout');
  assert.equal(x.issue, null);
});

test('no researcher configured: clear message', async () => {
  const { app } = await setup({}, null);
  const d = await located(app);
  await assert.rejects(rep.startReport(app, d, 'v1'), /isn’t configured/);
});

test('subscription request: consent, confirmation link, hand-off', async () => {
  const { app, store, mailer } = await setup({ SUBSCRIBE_URL: 'https://subs.example/start', SUBSCRIPTION_HANDOFF_SECRET: 'handoff-secret-123' });
  const d = await located(app);
  const r = await rep.startReport(app, d, 'v1', { sync: true });
  const bad = await rep.requestSubscription(app, d, r.id, { email: 'nope', consent: false, marketing: false });
  assert.equal(bad.ok, false);
  const ok = await rep.requestSubscription(app, d, r.id, { email: 'Me@Example.com', consent: true, marketing: true });
  assert.equal(ok.ok, true);
  const token = decodeURIComponent(mailer.outbox[0].text.match(/token=(\S+)/)![1]);
  const res = await rep.confirmSubscription(app, token);
  assert.ok('request' in res);
  assert.equal(res.request.status, 'confirmed');
  assert.equal(res.request.email, 'me@example.com');
  assert.equal(res.request.prefs.areaName, 'Lower Greenville');
  assert.match(res.handoffUrl!, /^https:\/\/subs\.example\/start\?request=/);
  assert.ok('error' in (await rep.confirmSubscription(app, token)), 'single use');
  const other = await ob.createDraft(app);
  await assert.rejects(rep.requestSubscription(app, other.draft, r.id, { email: 'x@example.com', consent: true, marketing: false }), /isn’t available/);
  assert.equal((await store.listSubscriptionRequests()).length, 1);
});
