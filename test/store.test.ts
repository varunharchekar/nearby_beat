/**
 * Store contract tests. Always run against MemoryStore.
 * Also run against PgStore when PGTEST_HOST is set (a local Postgres with db/migrations/001_core.sql applied).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.ts';
import { PgStore } from '../src/store/postgres.ts';
import type { Store, Report, SubscriptionRequest } from '../src/store/types.ts';
import { psqlQuery } from './support/psql.ts';
import { defaultPrefs } from '../src/domain/prefs.ts';
import type { ChangeEvent, SourceObservation } from '../src/domain/types.ts';

const stores: [string, () => Store][] = [['memory', () => new MemoryStore()]];
if (process.env.PGTEST_HOST) {
  const q = psqlQuery({ host: process.env.PGTEST_HOST, port: process.env.PGTEST_PORT ?? '5432', user: process.env.PGTEST_USER ?? 'postgres', db: process.env.PGTEST_DB ?? 'postgres' });
  stores.push(['postgres', () => new PgStore(q, Buffer.alloc(32, 7))]);
}
const uniq = () => Math.random().toString(36).slice(2, 10);

for (const [name, make] of stores) {
  test(`${name}: drafts, reports and expiry`, async () => {
    const s = make();
    const id = `d_${uniq()}`;
    const prefs = defaultPrefs([-96.77, 32.82], '100 Secret St', 'Lower Greenville');
    await s.saveDraft({ id, tokenHash: `h_${id}`, createdAt: 1, expiresAt: 1000, candidates: null, prefs, ack: false, runs: 0, currentReportId: null, proposals: [], geoNote: null, clarify: null });
    assert.equal((await s.getDraftByToken(`h_${id}`))?.prefs?.addressLabel, '100 Secret St');
    const base: Report = { id: `r_${uniq()}`, draftId: id, visitorKey: 'v1', version: 1, prefsKey: 'K', prefs, status: 'ready', error: null, progress: { stage: 'done', queries: ['q'], fetched: [] }, summary: 's', issue: null, dropped: [], usage: { searches: 3, inputTokens: 1, outputTokens: 1, costUsd: 0.1 }, researcher: 'fixture', createdAt: 10, finishedAt: 20, expiresAt: 1000 };
    await s.saveReport(base);
    await s.saveReport({ ...base, id: `r_${uniq()}`, status: 'failed', createdAt: 11 });
    await s.saveReport({ ...base, id: `r_${uniq()}`, status: 'running', createdAt: 12 });
    assert.equal((await s.getReport(base.id))?.prefs.addressLabel, '100 Secret St');
    assert.equal((await s.findReadyReport(id, 'K', 5))?.id, base.id);
    assert.equal(await s.findReadyReport(id, 'K', 15), null, 'too old to reuse');
    assert.equal(await s.countReports({ draftId: id, since: 0 }), 2, 'failed reports do not count');
    assert.equal(await s.countReports({ visitorKey: 'v1', since: 0 }), 2);
    assert.equal(await s.interruptRunning(30), 1);
    assert.equal(await s.countReports({ draftId: id, since: 0 }), 1);
    assert.ok((await s.listReports(10)).length >= 3);
    assert.ok((await s.deleteExpiredDrafts(5000)) >= 1);
    assert.equal(await s.getDraft(id), null);
    assert.equal(await s.getReport(base.id), null);
  });

  test(`${name}: subscription requests keep filters sealed`, async () => {
    const s = make();
    const r: SubscriptionRequest = { id: `sub_${uniq()}`, email: 'Person@Example.com', reportId: 'r1', prefs: defaultPrefs([-96.7, 32.8], '9 Hidden Rd', 'Lakewood'), consentAt: 1, marketing: false, status: 'pending_confirmation', createdAt: 1, confirmedAt: null };
    await s.saveSubscriptionRequest(r);
    await s.saveSubscriptionRequest({ ...r, status: 'confirmed', confirmedAt: 2 });
    const back = await s.getSubscriptionRequest(r.id);
    assert.equal(back?.email, 'person@example.com');
    assert.equal(back?.status, 'confirmed');
    assert.equal(back?.prefs.addressLabel, '9 Hidden Rd');
    assert.ok((await s.listSubscriptionRequests()).some((x) => x.id === r.id));
  });

  test(`${name}: magic links are single use and expire`, async () => {
    const s = make();
    const h = `ml_${uniq()}`;
    await s.saveMagicLink({ tokenHash: h, email: 'a@example.com', purpose: 'signup', payload: { x: 1 }, expiresAt: 100, usedAt: null, createdAt: 10 });
    assert.equal(await s.consumeMagicLink(h, 200), null, 'expired');
    const h2 = `ml_${uniq()}`;
    await s.saveMagicLink({ tokenHash: h2, email: 'a@example.com', purpose: 'signup', payload: { x: 1 }, expiresAt: 500, usedAt: null, createdAt: 10 });
    assert.deepEqual((await s.consumeMagicLink(h2, 200))?.payload, { x: 1 });
    assert.equal(await s.consumeMagicLink(h2, 201), null, 'second use');
    assert.ok((await s.countMagicLinks('a@example.com', 0)) >= 2);
  });

  test(`${name}: observations, entities and change dedupe`, async () => {
    const s = make();
    const sfx = uniq();
    const o: SourceObservation = { id: `o_${sfx}`, adapter: 'tabc', family: 'alcohol', recordId: `R${sfx}`, url: 'https://x', title: 't', publishedAt: 1, observedAt: 2, contentHash: 'h', sourceStatus: 'ok', facts: { name: 'N', cat: 'food', stage: 'filed', statusText: 'Filed', summary: 's' } };
    await s.saveObservation(o, { adapter: 'tabc', recordId: o.recordId, contentHash: 'h', facts: o.facts, lastObservationId: o.id });
    assert.equal((await s.getObservationState('tabc', o.recordId))?.contentHash, 'h');
    assert.equal((await s.getObservations([o.id]))[0].recordId, o.recordId);
    await s.saveEntity({ id: `e_${sfx}`, key: `k_${sfx}`, type: 'business', canonicalName: 'N', aliases: [], externalIds: [] });
    const ch: ChangeEvent = { id: `c_${sfx}`, entityId: `e_${sfx}`, dedupeKey: `dk_${sfx}`, type: 'status', cat: 'food', isEvent: false, stage: 'filed', name: 'N', place: 'P', geom: { type: 'Point', coordinates: [-96.77, 32.82] }, status: 'Filed', summary: 's', publishedAt: 1, observedAt: 2, approvedAt: null, family: 'alcohol', evidenceIds: [o.id], evidenceLabel: 'Primary record', review: 'needs_review', reviewReasons: [] };
    assert.equal(await s.saveChange(ch), true);
    assert.equal(await s.saveChange({ ...ch, id: `c2_${sfx}` }), false, 'same dedupe key');
    assert.equal(await s.saveChange({ ...ch, review: 'approved', approvedAt: 50 }), true, 'update by id');
    const approved = await s.listChanges({ review: 'approved', since: 10, field: 'approvedAt' });
    assert.ok(approved.some((x) => x.id === ch.id));
  });

  test(`${name}: jobs and kv`, async () => {
    const s = make();
    const key = `job_${uniq()}`;
    assert.equal(await s.enqueueJob({ id: key, type: 't', key, payload: { n: 1 }, runAt: 1 }), true);
    assert.equal(await s.enqueueJob({ id: `${key}b`, type: 't', key, payload: {}, runAt: 1 }), false);
    let j = await s.claimJob(Number.MAX_SAFE_INTEGER);
    while (j && j.key !== key) { await s.finishJob(j.id, true, null, null); j = await s.claimJob(Number.MAX_SAFE_INTEGER); }
    assert.equal(j?.attempts, 1);
    await s.finishJob(j!.id, false, 'boom', 2);
    const again = await s.claimJob(Number.MAX_SAFE_INTEGER);
    assert.equal(again?.attempts, 2);
    await s.kvSet('x', { a: 1 });
    assert.deepEqual(await s.kvGet('x'), { a: 1 });
  });
}

if (process.env.PGTEST_HOST) {
  test('postgres: migrations apply once, in order (PostGIS migration skipped where unavailable)', async () => {
    const { migrate } = await import('../src/store/migrate.ts');
    const base = { host: process.env.PGTEST_HOST!, port: process.env.PGTEST_PORT ?? '5432', user: process.env.PGTEST_USER ?? 'postgres' };
    const admin = psqlQuery({ ...base, db: 'postgres' });
    const db = `mig_${uniq()}`;
    await admin(`CREATE DATABASE ${db}`);
    const q = psqlQuery({ ...base, db });
    const skip = process.env.PGTEST_POSTGIS ? undefined : /spatial/;
    assert.deepEqual(await migrate(q, { skip }), skip ? ['001_core.sql', '003_reports.sql'] : ['001_core.sql', '002_spatial.sql', '003_reports.sql']);
    assert.deepEqual(await migrate(q, { skip }), []);
    const tables = (await q(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`)).rows[0].n;
    assert.ok(tables >= 13);
    await admin(`DROP DATABASE ${db}`);
  });
}
