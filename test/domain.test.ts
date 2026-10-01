import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areaOf, areaSqMi, AREA_LIMIT_SQMI, geodesic, halfPlane, M_PER_MI, matchGeom, projector } from '../src/domain/geo.ts';
import { cutoffFor, firstIssueAfter, isFifthSunday, localDateKey, nextSunday, sundaysBetween, zonedToUtc } from '../src/domain/time.ts';
import { applyOps, defaultPrefs, depthLabel, diffPrefs, prefsKey, presetMap, validatePrefs } from '../src/domain/prefs.ts';
import { parseGeo, parseRefine } from '../src/domain/parse.ts';
import { deriveChanges, detectConflict, entityKey, evidenceLabel, reminderFor, resolveEntity, reviewFor } from '../src/domain/changes.ts';
import { buildContent, eligible } from '../src/domain/eligibility.ts';
import { creditEffect, dispatchCheck, entitlementFor, trialUsed, billingState } from '../src/domain/ledger.ts';
import type { AccountLike } from '../src/domain/ledger.ts';
import { applyStripeEvent, emptyBilling } from '../src/domain/billing.ts';
import { buildIssue, renderHtml, renderText, subjectFor, validateIssue } from '../src/domain/issue.ts';
import type { ChangeEvent, Prefs, Pt, SourceObservation } from '../src/domain/types.ts';

const C: Pt = [-96.77, 32.82];
const pr = projector(C);
const at = (x: number, y: number) => pr.inv(x, y);
const P = (over: Partial<Prefs> = {}): Prefs => ({ ...defaultPrefs(C, '100 Test St', 'Test Hood'), ...over });

/* ---------------- geometry ---------------- */
test('radius boundary point is included; just outside is not', () => {
  const a = areaOf(P());
  assert.ok(matchGeom({ type: 'Point', coordinates: at(M_PER_MI, 0) }, a));
  assert.equal(matchGeom({ type: 'Point', coordinates: at(M_PER_MI + 5, 0) }, a), null);
});

test('street corridor extends coverage beyond the radius', () => {
  const far = at(0, 3000);
  const corridor = { kind: 'corridor' as const, coords: [at(0, 0), at(0, 4000)], widthM: 150, label: 'Test Ave' };
  assert.equal(matchGeom({ type: 'Point', coordinates: far }, areaOf(P())), null);
  assert.ok(matchGeom({ type: 'Point', coordinates: at(100, 3000) }, areaOf(P({ areaMode: 'custom', inc: [corridor] }))));
  assert.equal(matchGeom({ type: 'Point', coordinates: at(200, 3000) }, areaOf(P({ areaMode: 'custom', inc: [corridor] }))), null);
});

test('exclusions override both the circle and added areas', () => {
  const north = { kind: 'poly' as const, coords: halfPlane('north', at(0, 500)), label: 'North of X' };
  const inc = { kind: 'poly' as const, coords: [at(-500, 2000), at(500, 2000), at(500, 3000), at(-500, 3000)], label: 'Added' };
  const a = areaOf(P({ areaMode: 'custom', inc: [inc], exc: [north] }));
  assert.equal(matchGeom({ type: 'Point', coordinates: at(0, 1000) }, a), null, 'circle part north of line excluded');
  assert.equal(matchGeom({ type: 'Point', coordinates: at(0, 2500) }, a), null, 'added area north of line excluded');
  assert.ok(matchGeom({ type: 'Point', coordinates: at(0, 0) }, a));
});

test('custom mode off ignores stored shapes', () => {
  const exc = { kind: 'poly' as const, coords: halfPlane('north', at(0, -5000)), label: 'everything' };
  assert.ok(matchGeom({ type: 'Point', coordinates: at(0, 0) }, areaOf(P({ areaMode: 'radius', exc: [exc] }))));
});

test('a line crossing the boundary is partly in the area', () => {
  const m = matchGeom({ type: 'LineString', coordinates: [at(0, -500), at(0, 4000)] }, areaOf(P()));
  assert.ok(m);
  assert.equal(m!.partly, true);
  assert.ok(m!.dist < 30, `closest sampled point ${m!.dist} m`);
});

test('area estimate and launch limit', () => {
  const one = areaSqMi(areaOf(P()));
  assert.ok(Math.abs(one - Math.PI) / Math.PI < 0.03, `1-mile circle ≈ π sq mi, got ${one}`);
  const five = areaSqMi(areaOf(P({ radiusMi: 5 })));
  assert.ok(five <= AREA_LIMIT_SQMI * 1.03);
  const big = areaSqMi(areaOf(P({ radiusMi: 5, areaMode: 'custom', inc: [{ kind: 'poly', coords: [at(0, 0), at(15000, 0), at(15000, 15000), at(0, 15000)], label: 'big' }] })));
  assert.ok(big > AREA_LIMIT_SQMI);
});

test('geodesic distance sanity', () => {
  const d = geodesic([-96.8, 32.8], [-96.8, 32.9]);
  assert.ok(Math.abs(d - 11119) < 30);
});

/* ---------------- scheduling ---------------- */
const CT = (s: string) => { const [d, t] = s.split('T'); const [y, m, dd] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number); return zonedToUtc(y, m, dd, h, mi); };

test('next Sunday 9am handles daylight saving', () => {
  assert.equal(new Date(nextSunday(CT('2026-10-01T10:30'))).toISOString(), '2026-10-04T14:00:00.000Z');
  assert.equal(new Date(nextSunday(CT('2026-10-30T12:00'))).toISOString(), '2026-11-01T15:00:00.000Z');
  assert.equal(new Date(nextSunday(CT('2026-10-04T08:59'))).toISOString(), '2026-10-04T14:00:00.000Z');
  assert.equal(new Date(nextSunday(CT('2026-10-04T09:00'))).toISOString(), '2026-10-11T14:00:00.000Z');
});

test('issue keys stay on the local Sunday across the DST change', () => {
  const s = nextSunday(CT('2026-10-30T12:00'));
  assert.equal(localDateKey(s), '2026-11-01');
  assert.equal(localDateKey(nextSunday(s)), '2026-11-08');
});

test('verification after the Saturday cutoff starts the following week', () => {
  assert.equal(localDateKey(firstIssueAfter(CT('2026-10-03T08:59'))), '2026-10-04');
  assert.equal(localDateKey(firstIssueAfter(CT('2026-10-03T09:01'))), '2026-10-11');
  assert.equal(new Date(cutoffFor(nextSunday(CT('2026-10-01T10:00')))).toISOString(), '2026-10-03T14:00:00.000Z');
});

test('fifth Sundays and 53-Sunday years', () => {
  assert.equal(isFifthSunday(CT('2026-11-29T09:00')), true);
  assert.equal(isFifthSunday(CT('2026-11-22T09:00')), false);
  assert.equal(sundaysBetween(CT('2023-01-01T00:00'), CT('2024-01-01T00:00')).length, 53);
  assert.equal(sundaysBetween(CT('2027-01-01T00:00'), CT('2028-01-01T00:00')).length, 52);
  assert.equal(sundaysBetween(CT('2026-11-01T00:00'), CT('2026-12-01T00:00')).length, 5);
});

/* ---------------- preferences and parsing ---------------- */
test('validation, depth labels and diffs', () => {
  assert.deepEqual(validatePrefs(P({ cats: [] })), ['Choose at least one kind of change.']);
  assert.equal(depthLabel(P()), 'Balanced research');
  const custom = P({ fams: { ...presetMap('bal'), jobs: false } });
  assert.equal(depthLabel(custom), 'Custom');
  const rows = diffPrefs(P(), applyOps(P(), [{ k: 'cats', v: ['food'] }, { k: 'len', v: 'brief' }]));
  assert.deepEqual(rows.map((r) => r[0]), ['Interests', 'Length']);
  assert.equal(prefsKey(P({ cats: ['food', 'dev'] })), prefsKey(P({ cats: ['dev', 'food'] })));
});

test('geography text becomes intents, never applied shapes', () => {
  const r = parseGeo('Include Knox Henderson, but exclude everything north of Mockingbird', ['Knox Henderson']);
  assert.equal(r.intents.length, 2);
  assert.deepEqual(r.intents[0], { mode: 'include', target: { kind: 'neighborhood', name: 'Knox Henderson' }, text: 'Include Knox Henderson' });
  assert.equal(r.intents[1].mode, 'exclude');
  assert.deepEqual(r.intents[1].target, { kind: 'direction', dir: 'north', road: 'mockingbird' });
});

test('a bare street name asks for a stretch; a segment has endpoints', () => {
  const r = parseGeo('Exclude this stretch of Greenville Ave');
  assert.equal(r.intents[0].target.kind, 'road');
  const s = parseGeo('exclude Greenville Ave from Ross Ave to Belmont Ave');
  assert.deepEqual(s.intents[0].target, { kind: 'segment', road: 'greenville ave', from: 'ross ave', to: 'belmont ave' });
});

test('refinement examples from the PRD', () => {
  const p = P();
  assert.deepEqual(parseRefine('Only food', p).ops, [{ k: 'cats', v: ['food'] }]);
  assert.deepEqual(parseRefine('Less detail', p).ops, [{ k: 'len', v: 'brief' }]);
  assert.deepEqual(parseRefine('Show permits only when construction is approved', p).ops, [{ k: 'statusMin', v: 'approved:records' }]);
  const g = parseRefine('Exclude this stretch of Greenville', p);
  assert.equal(g.ops.length, 0);
  assert.ok(g.geoText);
  assert.ok(parseRefine('widen the area', p).clarify);
  assert.deepEqual(parseRefine('make it 2 miles', p).ops, [{ k: 'radiusMi', v: 2 }]);
});

/* ---------------- changes and evidence ---------------- */
let n = 0;
const id = () => `c${++n}`;
const obs = (over: Partial<SourceObservation> & { facts?: Partial<SourceObservation['facts']> } = {}): SourceObservation => ({
  id: over.id ?? `o${++n}`, adapter: 'test', family: over.family ?? 'alcohol', recordId: 'R1', url: 'https://example.test/r1', title: 'Record R1',
  publishedAt: CT('2026-09-20T09:00'), observedAt: over.observedAt ?? CT('2026-09-20T10:00'), occurredAt: null, contentHash: over.contentHash ?? 'h1', sourceStatus: 'ok',
  facts: { name: 'Sable & Rye', address: '100 Test St', suite: '210', geom: { type: 'Point', coordinates: C }, cat: 'food', stage: 'filed', statusText: 'Application filed', summary: 'An application was filed.', ...(over.facts ?? {}) },
});

test('unchanged and immaterial observations create no change', () => {
  const o1 = obs();
  assert.equal(deriveChanges({ contentHash: 'h1', facts: o1.facts }, o1, 'e1', id).length, 0);
  const o2 = obs({ contentHash: 'h2', facts: { summary: 'Reworded summary.' } });
  assert.equal(deriveChanges({ contentHash: 'h1', facts: o1.facts }, o2, 'e1', id).length, 0);
});

test('a material date change appears with before and after', () => {
  const p = obs({ facts: { stage: 'construction', statusText: 'Under construction', openingDate: { text: 'Nov 2026', est: true } } });
  const o = obs({ contentHash: 'h2', facts: { stage: 'construction', statusText: 'Under construction', openingDate: { text: 'Feb 2027', est: true } } });
  const ch = deriveChanges({ contentHash: 'h1', facts: p.facts }, o, 'e1', id);
  assert.equal(ch.length, 1);
  assert.equal(ch[0].type, 'timeline');
  assert.equal(ch[0].before, 'Nov 2026');
  assert.equal(ch[0].after, 'Feb 2027');
});

test('stage transitions and closures need explicit evidence', () => {
  const p = obs();
  const approved = deriveChanges({ contentHash: 'h1', facts: p.facts }, obs({ contentHash: 'h3', facts: { stage: 'approved', statusText: 'License issued' } }), 'e1', id);
  assert.equal(approved[0].type, 'status');
  assert.equal(approved[0].after, 'License issued');
  const closed = deriveChanges({ contentHash: 'h1', facts: p.facts }, obs({ contentHash: 'h4', facts: { stage: 'closed', statusText: 'Closed', closed: true } }), 'e1', id);
  assert.equal(closed[0].type, 'closure');
});

test('different suites never merge; similar names at one address are flagged', () => {
  const a = { id: 'e1', key: entityKey({ name: 'Kestrel Ramen', address: '5 Main St', suite: '110' }), type: 'business' as const, canonicalName: 'Kestrel Ramen', aliases: [], address: '5 Main St', suite: '110', externalIds: [] };
  const r = resolveEntity({ name: 'Kestrel Ramen LLC', address: '5 Main Street', suite: '140', cat: 'food', stage: 'announced', statusText: '', summary: '' }, [a]);
  assert.equal(r.match, null);
  assert.equal(r.ambiguous.length, 1);
  const same = resolveEntity({ name: 'Kestrel Ramen, LLC', address: '5 Main Street', suite: '110', cat: 'food', stage: 'announced', statusText: '', summary: '' }, [a]);
  assert.equal(same.match?.id, 'e1');
});

test('job postings stay early signals and conflicts go to review', () => {
  assert.equal(evidenceLabel('jobs', 'announced'), 'Early signal');
  const d1 = deriveChanges(null, obs({ family: 'company', facts: { stage: 'construction', statusText: 'Opening soon', openingDate: { text: 'late October', est: true } } }), 'e9', id)[0];
  const prior = { ...d1, review: 'approved', reviewReasons: [] } as ChangeEvent;
  const d2 = deriveChanges(null, obs({ family: 'local_reporting', facts: { stage: 'construction', statusText: 'Opening soon', openingDate: { text: 'Nov 1', est: false } } }), 'e9', id)[0];
  const conflict = detectConflict([prior], d2);
  assert.ok(conflict && conflict.length === 2);
  assert.equal(reviewFor({ ...d2, conflict: conflict! }, 'flagged').review, 'needs_review');
  assert.equal(reviewFor(d2, 'flagged').review, 'approved');
  assert.equal(reviewFor(d2, 'all').review, 'needs_review');
  assert.equal(reviewFor({ ...d2, geom: null }, 'flagged').reasons[0], 'No confirmed location');
});

test('an upcoming opening gets exactly one reminder', () => {
  const now = CT('2026-10-02T10:00');
  const ev = deriveChanges(null, obs({ family: 'company', facts: { stage: 'construction', statusText: 'Grand opening scheduled', event: { at: CT('2026-10-10T11:00'), text: 'Sat, Oct 10', kind: 'grand' } } }), 'e7', id)[0];
  const c = { ...ev, review: 'approved', reviewReasons: [] } as ChangeEvent;
  const r = reminderFor(c, now, new Set(), id);
  assert.ok(r);
  assert.notEqual(r!.dedupeKey, c.dedupeKey);
  assert.equal(reminderFor(c, now, new Set([r!.dedupeKey]), id), null);
  assert.equal(reminderFor(c, CT('2026-09-20T10:00'), new Set(), id), null, 'more than 14 days out');
});

/* ---------------- eligibility ---------------- */
const change = (over: Partial<ChangeEvent>): ChangeEvent => ({
  id: over.id ?? id(), entityId: 'e', dedupeKey: over.dedupeKey ?? `k${n++}`, type: 'announcement', cat: 'food', isEvent: false, stage: 'announced', name: 'X', place: 'Here',
  geom: { type: 'Point', coordinates: at(100, 100) }, status: 'Announced', summary: 'Something changed.', date: null, publishedAt: CT('2026-09-20T09:00'),
  observedAt: CT('2026-09-20T10:00'), approvedAt: CT('2026-09-20T11:00'), family: 'company', evidenceIds: ['ev1'], evidenceLabel: 'Owner announcement', review: 'approved', reviewReasons: [], ...over,
});
const AV = new Set(['company', 'local_reporting', 'alcohol', 'zoning']);
const W = { from: CT('2026-09-01T00:00'), to: CT('2026-10-01T00:00'), field: 'approvedAt' as const };

test('opening events need the events category and a matching business category', () => {
  const ev = change({ isEvent: true, type: 'opening_event', cat: 'food' });
  assert.ok(eligible(ev, P(), W, AV));
  assert.equal(eligible(ev, P({ cats: ['food'] }), W, AV), null);
  assert.equal(eligible(ev, P({ cats: ['events', 'dev'] }), W, AV), null);
  assert.ok(eligible(ev, P({ cats: ['events', 'dev'], evAll: true }), W, AV));
});

test('unavailable or deselected families, unapproved and unlocated changes are excluded', () => {
  assert.equal(eligible(change({ family: 'permits' }), P(), W, AV), null);
  assert.equal(eligible(change({ family: 'jobs' }), P({ fams: { ...presetMap('bal'), jobs: false } }), W, new Set([...AV, 'jobs'])), null);
  assert.equal(eligible(change({ review: 'needs_review' }), P(), W, AV), null);
  assert.equal(eligible(change({ geom: null }), P(), W, AV), null);
  assert.equal(eligible(change({ family: 'alcohol' }), P(), W, AV, ['alcohol']), null, 'adapter down');
});

test('status filter hides record filings only when asked', () => {
  const filing = change({ family: 'alcohol', stage: 'filed' });
  assert.ok(eligible(filing, P(), W, AV));
  assert.equal(eligible(filing, P({ statusMin: 'approved:records' }), W, AV), null);
  assert.ok(eligible(change({ stage: 'announced' }), P({ statusMin: 'approved:records' }), W, AV), 'announcements unaffected by records-only filter');
});

test('content ranks openings first, respects length and dedupes', () => {
  const list = [change({ type: 'early', dedupeKey: 'a', entityId: 'e1' }), change({ type: 'opening_event', isEvent: true, dedupeKey: 'b', entityId: 'e2' }), change({ type: 'closure', dedupeKey: 'c', entityId: 'e3' }), change({ type: 'closure', dedupeKey: 'c', entityId: 'e3' }), change({ type: 'status', dedupeKey: 'd', entityId: 'e2' })];
  const c = buildContent(list, P(), W, AV);
  assert.equal(c.total, 3);
  assert.equal(c.main[0].id, list[1].id, 'one story per entity, highest ranked kept');
  const brief = buildContent(Array.from({ length: 7 }, (_, i) => change({ dedupeKey: `z${i}`, entityId: `z${i}` })), P({ len: 'brief' }), W, AV);
  assert.equal(brief.main.length, 4);
  assert.equal(brief.briefs.length, 0);
});

/* ---------------- ledger ---------------- */
const acct = (over: Partial<AccountLike> = {}): AccountLike => ({ verifiedAt: 1, consentAt: 1, emailState: 'active', paused: false, firstIssueAt: 0, checkoutPending: false, ledger: [], sub: null, ...over });

test('three trial credits, consumed once per issue key', () => {
  const a = acct();
  for (const k of ['k1', 'k2', 'k3']) {
    const d = dispatchCheck(a, 10, k);
    assert.deepEqual(d, { ok: true, credit: 'trial' });
    a.ledger.push({ issueKey: k, creditType: 'trial', consumedAt: 1 });
    assert.deepEqual(dispatchCheck(a, 10, k), { ok: false, reason: 'issue already delivered' });
  }
  assert.equal(trialUsed(a.ledger), 3);
  assert.deepEqual(dispatchCheck(a, 10, 'k4'), { ok: false, reason: 'no free issues left and no active plan' });
  assert.equal(billingState(a, 10), 'trial_exhausted');
});

test('credit rules for delivery and acceptance modes', () => {
  assert.equal(creditEffect('delivery', 'accepted', false), 'none');
  assert.equal(creditEffect('delivery', 'delivered', false), 'consume');
  assert.equal(creditEffect('delivery', 'delivered', true), 'none');
  assert.equal(creditEffect('delivery', 'failed', false), 'none');
  assert.equal(creditEffect('acceptance', 'accepted', false), 'consume');
  assert.equal(creditEffect('acceptance', 'bounced_hard', true), 'restore');
});

test('consent, suppression and pause block dispatch', () => {
  assert.equal((dispatchCheck(acct({ consentAt: null }), 10, 'k') as any).reason, 'no newsletter consent');
  assert.equal((dispatchCheck(acct({ emailState: 'suppressed' }), 10, 'k') as any).reason, 'email suppressed');
  assert.equal((dispatchCheck(acct({ paused: true }), 10, 'k') as any).reason, 'delivery paused');
  assert.equal((dispatchCheck(acct({ verifiedAt: null }), 10, 'k') as any).reason, 'email not verified');
});

test('paid terms cover every Sunday including the fifth, and stop at term end', () => {
  const start = CT('2026-11-01T00:00'), end = CT('2026-12-01T00:00');
  const a = acct({ ledger: [1, 2, 3].map((i) => ({ issueKey: `t${i}`, creditType: 'trial' as const, consumedAt: 1 })), sub: { status: 'active', plan: 'monthly', termStart: start, termEnd: end, cancelAtEnd: false } });
  for (const s of sundaysBetween(start, end)) assert.equal(entitlementFor(a, s), 'paid');
  assert.equal(entitlementFor(a, CT('2026-12-06T09:00')), null);
  a.sub!.status = 'canceled_pending_expiry';
  assert.equal(entitlementFor(a, CT('2026-11-29T09:00')), 'paid');
});

/* ---------------- billing events ---------------- */
const sub = (idv: string, created: number, status: string, extra: any = {}) => ({ id: idv, type: 'customer.subscription.updated', created, data: { object: { id: 'sub_1', customer: 'cus_1', status, cancel_at_period_end: false, current_period_start: 1_790_000_000, current_period_end: 1_792_600_000, items: { data: [{ price: { id: 'price_m', recurring: { interval: 'month' } } }] }, ...extra } } });

test('duplicate and out-of-order webhooks are safe', () => {
  let r = emptyBilling();
  r = applyStripeEvent(r, { id: 'evt_inv', type: 'invoice.paid', created: 100, data: { object: { subscription: 'sub_1' } } }).rec;
  assert.equal(r.heldInvoices.length, 1);
  r = applyStripeEvent(r, sub('evt_2', 200, 'active'), { monthly: 'price_m' }).rec;
  assert.equal(r.sub?.status, 'active');
  assert.equal(r.sub?.plan, 'monthly');
  assert.equal(r.heldInvoices.length, 0);
  assert.equal(r.paidInvoices.length, 1);
  const dup = applyStripeEvent(r, sub('evt_2', 200, 'active'));
  assert.equal(dup.changed, false);
  const older = applyStripeEvent(r, sub('evt_1', 150, 'incomplete'));
  assert.equal(older.rec.sub?.status, 'active', 'older event does not regress state');
  const canceled = applyStripeEvent(r, sub('evt_3', 300, 'active', { cancel_at_period_end: true })).rec;
  assert.equal(canceled.sub?.status, 'canceled_pending_expiry');
  const failed = applyStripeEvent(canceled, { id: 'evt_4', type: 'invoice.payment_failed', created: 400, data: { object: {} } }).rec;
  assert.equal(failed.sub?.status, 'past_due');
});

/* ---------------- issue rendering ---------------- */
test('issues validate citations and render without the home address', () => {
  const c = change({ id: 'cx', name: 'Lantern Tortilla Co.', date: { text: 'Sat, Oct 10', est: false }, evidenceIds: ['ev1'] });
  const changes = new Map([[c.id, c]]);
  const evidence = new Map([['ev1', { id: 'ev1', title: 'Announcement', url: 'https://example.test/a', recordId: 'A1', family: 'company', publishedAt: c.publishedAt, observedAt: c.observedAt }]]);
  const content = buildContent([c], P(), W, AV);
  const issue = buildIssue('weekly', content, changes, evidence, P(), { from: W.from, to: W.to, tz: 'America/Chicago', limitations: [], fixture: false, coverageOk: 4 });
  assert.deepEqual(validateIssue(issue, changes, evidence), []);
  const html = renderHtml(issue, { preferences: 'https://x/p', unsubscribe: 'https://x/u' });
  const text = renderText(issue, { preferences: 'https://x/p', unsubscribe: 'https://x/u' });
  for (const out of [html, text, subjectFor(issue, CT('2026-10-04T09:00'))]) assert.ok(!out.includes('100 Test St'));
  assert.ok(html.includes('https://example.test/a') && text.includes('Unsubscribe: https://x/u'));
  const tampered = { ...issue, items: [{ ...issue.items[0], date: { text: 'Oct 1', est: false } }] };
  assert.ok(validateIssue(tampered, changes, evidence).some((e) => e.includes('date differs')));
  const quiet = buildIssue('weekly', { main: [], briefs: [], total: 0 }, changes, evidence, P(), { from: 0, to: 1, tz: 'America/Chicago', limitations: [], fixture: false, coverageOk: 4 });
  assert.equal(quiet.kind, 'quiet');
});
