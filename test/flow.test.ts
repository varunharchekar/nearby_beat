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

test('articles mode (default): no government feeds or records in the report', async () => {
  const { app, store } = await setup();
  assert.equal(app.cfg.research.sources, 'articles');
  const d = await located(app);
  const r = await rep.startReport(app, d, 'v1', { sync: true });
  const x = (await store.getReport(r.id))!;
  const items = [...x.issue!.items, ...x.issue!.briefs];
  assert.ok(items.length > 0);
  assert.ok(items.every((i) => i.evidenceLabel !== 'Primary record'), 'no official records');
  assert.ok(x.issue!.limitations.some((l) => l.includes('does not check permit')));
  assert.equal(x.issue!.depth, 'Standard');
});

test('all-sources mode includes official records', async () => {
  const { app, store } = await setup({ RESEARCH_SOURCES: 'all' });
  const d = await located(app);
  const r = await rep.startReport(app, d, 'v1', { sync: true });
  const x = (await store.getReport(r.id))!;
  assert.ok([...x.issue!.items, ...x.issue!.briefs].some((i) => i.evidenceLabel === 'Primary record'));
});

test('articles mode never asks to confirm source availability', async () => {
  const { app } = await setup({ NEARBY_MODE: 'live', SESSION_SECRET: 'x'.repeat(40), ADDRESS_ENCRYPTION_KEY: '1'.repeat(64) }, null);
  const { draft } = await ob.createDraft(app);
  draft.prefs = (await import('../src/domain/prefs.ts')).defaultPrefs([-96.77, 32.81], '2000 Greenville Ave, Dallas, TX', 'Lower Greenville');
  assert.deepEqual(ob.reportBlockers(app, draft), []);
  await assert.rejects(rep.startReport(app, draft, 'v1'), /ANTHROPIC_API_KEY is missing/);
});

test('second pass runs when the first finds too few items', async () => {
  const calls: { alreadyFound?: string[]; minItems?: number }[] = [];
  const src = 'https://news.example/a';
  const item = (n: number) => ({ name: `Cafe ${n}`, category: 'food' as const, stage: 'announced' as const, status: 'Upcoming', what: 'New cafe.', address: `${n} Sample Street`, evidence_type: 'news_report' as const, sources: [{ url: src }], coords: [-96.77, 32.81] as [number, number] });
  const r: Researcher = {
    name: 'fixture',
    async run(req) {
      calls.push({ alreadyFound: req.alreadyFound, minItems: req.minItems });
      const items = calls.length === 1 ? [item(1), item(2)] : [item(2), item(3), item(4)];
      return { report: { summary: 's', items }, seenUrls: new Map([[src, { title: 'A' }]]), usage: { searches: 3, inputTokens: 1, outputTokens: 1, costUsd: 0.1 } };
    },
  };
  const { app, store } = await setup({ MIN_ITEMS: '5' }, r);
  const d = await located(app);
  d.prefs!.cats = ['food'];
  const rep0 = await rep.startReport(app, d, 'v1', { sync: true });
  const x = (await store.getReport(rep0.id))!;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].minItems, 3);
  assert.ok(calls[1].alreadyFound!.some((n) => n.startsWith('Cafe 1')));
  assert.equal(x.issue!.items.length + x.issue!.briefs.length, 4, 'merged and deduplicated');
  assert.equal(x.usage!.searches, 6);
});

test('item placement: a same-named street near the user is not accepted for another city', async () => {
  const center: [number, number] = [-97.77, 30.25];
  const calls: string[] = [];
  const geocoder = { name: 'fake', async search(q: string) { calls.push(q); return [{ label: '12 Bedford Ave', city: 'Austin, TX, 78704', point: center, kind: 'address' as const, approx: false }]; } };
  const app = { geocoder } as any;
  assert.deepEqual(rep.namedPlaces('12 Bedford Ave, Brooklyn, NY 11211'), ['Brooklyn']);
  assert.deepEqual(rep.namedPlaces('12 Bedford Ave'), []);
  assert.equal(await rep.geocodeNear(app, '12 Bedford Ave, Brooklyn, NY 11211', center, 'Austin, TX'), null, 'Brooklyn address is not snapped to Austin');
  assert.ok(calls.every((q) => !q.includes('Austin')), 'user city not glued onto another city');
  assert.deepEqual(await rep.geocodeNear(app, '12 Bedford Ave, Austin, TX', center, 'Austin, TX'), center);
  assert.deepEqual(await rep.geocodeNear(app, '12 Bedford Ave', center, 'Austin, TX'), center, 'no city given: user city is assumed');
});

test('recency: old openings are left out; ongoing projects need an update within a year', async () => {
  const { assemble } = await import('../src/research/assemble.ts');
  const { defaultPrefs } = await import('../src/domain/prefs.ts');
  const now = Date.parse('2026-10-02T12:00:00Z');
  const p = defaultPrefs([-96.77, 32.81], '2000 Greenville Ave, Dallas, TX', 'Lower Greenville');
  const mk = (name: string, stage: string, published: string) => ({ name, category: 'food' as const, stage: stage as any, status: 's', what: 'w', address: 'a', evidence_type: 'news_report' as const, sources: [{ url: `https://n.example/${name}`, published }], coords: [-96.77, 32.81] as [number, number] });
  const items = [mk('Old Opening', 'open', '2025-04-01'), mk('New Opening', 'open', '2026-09-20'), mk('Slow Project', 'construction', '2026-01-10'), mk('Stale Project', 'construction', '2025-06-01')];
  const out = await assemble({ report: { summary: '', items }, seenUrls: new Map(items.map((i) => [i.sources[0].url, { title: i.name }])), usage: { searches: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } },
    p, { geocode: async () => null, from: now - 60 * 86_400_000, to: now, tz: 'America/Chicago', fixture: false, limitations: [], recordUrls: new Set(), trustCoords: true });
  const kept = [...out.issue.items, ...out.issue.briefs].map((i) => i.name).sort();
  assert.deepEqual(kept, ['New Opening', 'Slow Project']);
  assert.deepEqual(out.dropped.map((d) => d.reason), ['older than your time window', 'older than your time window']);
});

test('item placement: boroughs and neighborhoods inside a bigger city still match', async () => {
  const center: [number, number] = [-73.95, 40.71];
  const geocoder = { name: 'fake', async search() { return [{ label: '200 Grand St', city: 'New York, NY, 11211', places: ['Williamsburg', 'Brooklyn', 'New York'], point: center, kind: 'address' as const, approx: false }]; } };
  const app = { geocoder } as any;
  assert.deepEqual(await rep.geocodeNear(app, '200 Grand St, Brooklyn, NY 11211', center, 'Brooklyn, New York, NY'), center);
  assert.deepEqual(await rep.geocodeNear(app, '200 Grand St, Williamsburg, Brooklyn, NY', center, 'Brooklyn, New York, NY'), center);
  // Without the borough names from the provider, the user's own city string still counts.
  const bare = { geocoder: { name: 'fake', async search() { return [{ label: '200 Grand St', city: 'New York, NY', point: center, kind: 'address' as const, approx: false }]; } } } as any;
  assert.deepEqual(await rep.geocodeNear(bare, '200 Grand St, Brooklyn, NY', center, 'Brooklyn, New York, NY'), center);
  assert.equal(await rep.geocodeNear(bare, '200 Grand St, Jersey City, NJ', center, 'Brooklyn, New York, NY'), null, 'other state rejected');
});
