/**
 * Store contract tests. Always run against MemoryStore.
 * Also run against PgStore when PGTEST_HOST is set (a local Postgres with db/migrations/001_core.sql applied).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory.ts';
import { PgStore } from '../src/store/postgres.ts';
import type { Store, Account, Issue, Preview } from '../src/store/types.ts';
import { psqlQuery } from './support/psql.ts';
import { defaultPrefs } from '../src/domain/prefs.ts';
import { emptyBilling } from '../src/domain/billing.ts';
import type { ChangeEvent, SourceObservation } from '../src/domain/types.ts';

const stores: [string, () => Store][] = [['memory', () => new MemoryStore()]];
if (process.env.PGTEST_HOST) {
  const q = psqlQuery({ host: process.env.PGTEST_HOST, port: process.env.PGTEST_PORT ?? '5432', user: process.env.PGTEST_USER ?? 'postgres', db: process.env.PGTEST_DB ?? 'postgres' });
  stores.push(['postgres', () => new PgStore(q, Buffer.alloc(32, 7))]);
}
const uniq = () => Math.random().toString(36).slice(2, 10);

for (const [name, make] of stores) {
  test(`${name}: drafts, previews and expiry`, async () => {
    const s = make();
    const id = `d_${uniq()}`;
    const prefs = defaultPrefs([-96.77, 32.82], '100 Secret St', 'Lower Greenville');
    await s.saveDraft({ id, tokenHash: `h_${id}`, createdAt: 1, expiresAt: 1000, candidates: null, prefs, ack: false, gens: 0, currentPreviewId: null, approvedPreviewId: null, proposals: [], geoNote: null, clarify: null });
    assert.equal((await s.getDraftByToken(`h_${id}`))?.prefs?.addressLabel, '100 Secret St');
    const pv: Preview = { id: `p_${uniq()}`, draftId: id, accountId: null, version: 1, prefsKey: 'K', prefs, snapshotId: 'S', periodFrom: 0, periodTo: 1, status: 'ready', error: null, content: { main: [], briefs: [], total: 0 }, issue: null, down: [], cached: false, createdAt: 1, approvedAt: null, expiresAt: 1000 };
    await s.savePreview(pv);
    assert.equal((await s.findReadyPreview(id, 'K', 'S'))?.id, pv.id);
    assert.equal(await s.findReadyPreview(id, 'K', 'other'), null);
    assert.equal(await s.countPreviews(id), 1);
    assert.ok((await s.deleteExpiredDrafts(5000)) >= 1);
    assert.equal(await s.getDraft(id), null);
    assert.equal(await s.getPreview(pv.id), null);
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

  test(`${name}: accounts keep prefs sealed and round-trip`, async () => {
    const s = make();
    const a: Account = { id: `a_${uniq()}`, email: `${uniq()}@Example.com`, verifiedAt: 1, tz: 'America/Chicago', consentVersion: 'v1', consentAt: 1, marketingConsent: false, emailState: 'active', paused: false, firstIssueAt: 5, lastCutoff: 1, checkoutPending: false, checkoutPlan: null, prefs: defaultPrefs([-96.7, 32.8], '9 Hidden Rd', 'Lakewood'), prefsVersion: 1, approvedPreviewId: null, createdAt: 1 };
    await s.saveAccount(a);
    const back = await s.getAccountByEmail(a.email.toUpperCase());
    assert.equal(back?.prefs.addressLabel, '9 Hidden Rd');
    assert.equal(back?.firstIssueAt, 5);
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

  test(`${name}: ledger is unique per issue key; restore allows re-consume`, async () => {
    const s = make();
    const a = `a_${uniq()}`;
    assert.equal(await s.consumeCredit(a, { issueKey: 'k1', creditType: 'trial', consumedAt: 1 }), true);
    assert.equal(await s.consumeCredit(a, { issueKey: 'k1', creditType: 'trial', consumedAt: 2 }), false);
    await s.restoreCredit(a, 'k1', 3);
    assert.equal((await s.listLedger(a))[0].restoredAt, 3);
    assert.equal(await s.consumeCredit(a, { issueKey: 'k1', creditType: 'trial', consumedAt: 4 }), true);
    assert.equal((await s.listLedger(a))[0].restoredAt, null);
  });

  test(`${name}: issues, billing, jobs and kv`, async () => {
    const s = make();
    const a: Account = { id: `a_${uniq()}`, email: `${uniq()}@example.com`, verifiedAt: 1, tz: 'America/Chicago', consentVersion: 'v1', consentAt: 1, marketingConsent: false, emailState: 'active', paused: false, firstIssueAt: 5, lastCutoff: 1, checkoutPending: false, checkoutPlan: null, prefs: defaultPrefs([-96.7, 32.8], 'x', 'y'), prefsVersion: 1, approvedPreviewId: null, createdAt: 1 };
    await s.saveAccount(a);
    const i: Issue = { id: `i_${uniq()}`, accountId: a.id, scheduleKey: '2026-10-04', sunday: 9, kind: 'weekly', prefsVersion: 1, snapshotId: 's', cutoff: 8, windowFrom: 1, subject: 'S', structured: {} as any, html: '<p>', text: 't', status: 'accepted', providerMessageId: `msg_${uniq()}`, attempts: 1, credit: 'none', createdAt: 1, updatedAt: 1 };
    await s.saveIssue(i);
    await s.saveIssue({ ...i, status: 'delivered' });
    assert.equal((await s.getIssueByMessageId(i.providerMessageId!))?.status, 'delivered');
    assert.equal((await s.listIssues(a.id)).length, 1);
    const b = { ...emptyBilling(), customerId: `cus_${uniq()}` };
    await s.saveBilling(a.id, b);
    assert.equal(await s.findAccountIdByCustomer(b.customerId!), a.id);
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
    await s.deleteAccount(a.id);
    assert.equal(await s.getAccount(a.id), null);
    assert.equal((await s.listIssues(a.id)).length, 0);
  });
}
