/** Anonymous onboarding: drafts, area editing, previews, refinement and approval. */
import type { App } from '../app.ts';
import type { Prefs, Pt, Shape } from '../domain/types.ts';
import type { Draft, Preview } from '../store/types.ts';
import { applyOps, defaultPrefs, diffPrefs, effectiveFams, prefsKey, unavailableSelected, validatePrefs } from '../domain/prefs.ts';
import type { DiffRow, PrefOp } from '../domain/prefs.ts';
import { parseGeo, parseRefine } from '../domain/parse.ts';
import { areaOf, areaSqMi, AREA_LIMIT_SQMI } from '../domain/geo.ts';
import { buildContent } from '../domain/eligibility.ts';
import { buildIssue, validateIssue } from '../domain/issue.ts';
import type { EvidenceRef } from '../domain/issue.ts';
import { DAY } from '../domain/time.ts';
import { PREVIEW_LIMITS } from '../domain/ledger.ts';
import { newId, randomToken, sha256 } from '../lib/crypto.ts';
import { findAddress, inCoverage, nearestNeighborhood, resolveIntents } from './geo.ts';
import type { Proposal } from './geo.ts';

export const DRAFT_TTL = DAY;
export class UserError extends Error {}

export async function createDraft(app: App): Promise<{ draft: Draft; token: string }> {
  const token = randomToken();
  const now = app.clock.now();
  const draft: Draft = { id: newId('drf'), tokenHash: sha256(token), createdAt: now, expiresAt: now + DRAFT_TTL, candidates: null, prefs: null, ack: false, gens: 0, currentPreviewId: null, approvedPreviewId: null, proposals: [], geoNote: null, clarify: null };
  await app.store.saveDraft(draft);
  return { draft, token };
}

export async function loadDraft(app: App, token: string | undefined): Promise<Draft | null> {
  if (!token) return null;
  const d = await app.store.getDraftByToken(sha256(token));
  return d && d.expiresAt > app.clock.now() ? d : null;
}

export async function searchAddress(app: App, d: Draft, q: string) {
  const query = q.trim();
  if (query.length < 3) throw new UserError('Enter an address, intersection or ZIP code.');
  const c = await findAddress(app, query);
  if (!c.length) throw new UserError('We couldn’t find that address. Add a city or ZIP code, or try a nearby intersection.');
  d.candidates = c;
  await app.store.saveDraft(d);
  return c;
}

/** Confirm a candidate (optionally with a corrected pin). Outside coverage returns `covered: false` and nothing is saved. */
export async function confirmLocation(app: App, d: Draft, candidateId: string, adjusted?: Pt, radiusMi?: number): Promise<{ covered: boolean }> {
  const c = d.candidates?.find((x) => x.id === candidateId);
  if (!c) throw new UserError('Choose one of the matches.');
  if (!c.covered) return { covered: false };
  if (adjusted && !inCoverage(app, adjusted)) throw new UserError('That pin is outside our coverage area. Move it closer to your address.');
  const point = adjusted ?? c.point;
  const radius = radiusMi ?? d.prefs?.radiusMi ?? 1;
  const base = defaultPrefs(point, `${c.label}, ${c.city}`, await nearestNeighborhood(app, point));
  // A new location clears drawn shapes and any approval: they were relative to the old pin.
  d.prefs = d.prefs ? { ...d.prefs, center: point, addressLabel: base.addressLabel, areaName: base.areaName, radiusMi: radius, inc: [], exc: [], areaMode: 'radius' } : { ...base, radiusMi: radius };
  d.approvedPreviewId = null;
  d.proposals = [];
  d.candidates = null;
  await app.store.saveDraft(d);
  return { covered: true };
}

export async function joinWaitlist(app: App, email: string, area: string, consent: boolean) {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new UserError('Enter a valid email address.');
  if (!consent) throw new UserError('Tick the box to join the waitlist.');
  const now = app.clock.now();
  await app.store.addWaitlist({ id: newId('wl'), email: email.toLowerCase(), area, consentAt: now, createdAt: now });
}

export function requirePrefs(d: Draft): Prefs {
  if (!d.prefs) throw new UserError('Confirm your location first.');
  return d.prefs;
}

export async function setPrefs(app: App, d: Draft, next: Prefs) {
  d.prefs = next;
  await app.store.saveDraft(d);
}

/* ---------- area editing ---------- */
export async function proposeFromText(app: App, d: Draft, text: string) {
  const p = requirePrefs(d);
  const hoods = await knownNeighborhoods(app, p.center);
  const parsed = parseGeo(text, hoods);
  const r = await resolveIntents(app, parsed.intents, p.center);
  d.proposals.push(...r.proposals);
  d.clarify = r.clarify;
  const fails = [...parsed.fails, ...r.fails];
  d.geoNote = [
    r.proposals.length ? `Proposed ${r.proposals.length} change${r.proposals.length === 1 ? '' : 's'} on the map. Nothing applies until you confirm.` : '',
    r.clarify ? `Which stretch of ${r.clarify.road}? Choose cross streets below.` : '',
    fails.length ? `Couldn't place: ${fails.join('; ')}. Your text is kept, and you can use the neighborhood, street or drawing tools instead.` : '',
  ].filter(Boolean).join(' ');
  await app.store.saveDraft(d);
  return { ...r, fails };
}

async function knownNeighborhoods(app: App, center: Pt): Promise<string[]> {
  try { return (await app.geocoder.search('neighborhood', { types: ['neighborhood'], proximity: center, limit: 10 })).map((x) => x.label); } catch { return []; }
}

export async function proposeSegment(app: App, d: Draft, mode: 'include' | 'exclude', road: string, from: string, to: string, widthM: number) {
  const p = requirePrefs(d);
  if (!road.trim() || !from.trim() || !to.trim()) throw new UserError('Enter the street and both cross streets.');
  if (from.trim().toLowerCase() === to.trim().toLowerCase()) throw new UserError('Choose two different cross streets.');
  const r = await resolveIntents(app, [{ mode, target: { kind: 'segment', road, from, to }, text: `${road} from ${from} to ${to}` }], p.center);
  if (!r.proposals.length) throw new UserError(`We couldn't find where ${road} meets ${from} and ${to}. Check the names or draw the area instead.`);
  r.proposals[0].shape.widthM = Math.max(25, Math.min(600, widthM || 150));
  r.proposals[0].shape.label += `, ${r.proposals[0].shape.widthM} m each side`;
  d.proposals.push(...r.proposals);
  d.clarify = null;
  await app.store.saveDraft(d);
}

export async function proposeNeighborhood(app: App, d: Draft, mode: 'include' | 'exclude', name: string) {
  const p = requirePrefs(d);
  const r = await resolveIntents(app, [{ mode, target: { kind: 'neighborhood', name }, text: name }], p.center);
  if (!r.proposals.length) throw new UserError(`We don't have a boundary for ${name}. Draw it on the map instead.`);
  d.proposals.push(...r.proposals);
  await app.store.saveDraft(d);
}

export async function proposeDrawn(app: App, d: Draft, mode: 'include' | 'exclude', coords: Pt[]) {
  requirePrefs(d);
  if (coords.length < 3 || coords.some((c) => !Array.isArray(c) || c.length !== 2 || !c.every(Number.isFinite))) throw new UserError('A drawn shape needs at least 3 points.');
  const n = d.proposals.length + (d.prefs!.inc.length + d.prefs!.exc.length) + 1;
  d.proposals.push({ id: newId('prop'), mode, shape: { kind: 'poly', coords, label: `Drawn ${mode === 'include' ? 'inclusion' : 'exclusion'} ${n}` } });
  await app.store.saveDraft(d);
}

export async function resolveProposal(app: App, d: Draft, id: string, apply: boolean) {
  const p = requirePrefs(d);
  const prop = d.proposals.find((x) => x.id === id);
  if (!prop) throw new UserError('That proposal is no longer available.');
  d.proposals = d.proposals.filter((x) => x.id !== id);
  if (apply) {
    p.areaMode = 'custom';
    const shape: Shape = { ...prop.shape, label: prop.shape.label.replace(/ \(suggested boundary\)| \(straight line[^)]*\)/, '') };
    (prop.mode === 'exclude' ? p.exc : p.inc).push(shape);
  }
  await app.store.saveDraft(d);
}

export async function removeShape(app: App, d: Draft, kind: 'inc' | 'exc', index: number) {
  const p = requirePrefs(d);
  p[kind].splice(index, 1);
  await app.store.saveDraft(d);
}

export function areaCheck(p: Prefs) {
  const a = areaOf(p);
  const sq = areaSqMi(a);
  return { sqMi: sq, over: sq > AREA_LIMIT_SQMI, limit: AREA_LIMIT_SQMI };
}

/** Everything that must be true before a preview can be generated. */
export function previewBlockers(app: App, d: Draft): string[] {
  if (!d.prefs) return ['Confirm your location first.'];
  const b = validatePrefs(d.prefs);
  if (d.proposals.length) b.push('Apply or discard the proposed area changes first.');
  if (d.clarify) b.push(`Choose which stretch of ${d.clarify.road} you meant, or dismiss the question.`);
  if (areaCheck(d.prefs).over) b.push('Your area is larger than the launch limit (a 5-mile circle). Remove or shrink a shape.');
  if (unavailableSelected(d.prefs, app.registry.available).length && !d.ack) b.push('Confirm that you want to continue with the available sources.');
  if (!effectiveFams(d.prefs, app.registry.available).length) b.push('Turn on at least one available source.');
  return b;
}

/* ---------- previews ---------- */
export async function currentSnapshot(app: App) {
  const approved = await app.store.listChanges({ review: 'approved' });
  const max = approved.reduce((m, c) => Math.max(m, c.approvedAt ?? 0), 0);
  return { id: `snap_${approved.length}_${max}`, changes: approved };
}

/** Families whose adapters all failed in the last 24 hours. */
export async function downFamilies(app: App): Promise<string[]> {
  const runs = await app.store.listAdapterRuns(500);
  const now = app.clock.now();
  const byFam = new Map<string, boolean[]>();
  for (const a of app.registry.adapters) {
    const last = runs.find((r) => r.adapter === a.id && r.at > now - DAY);
    if (!last) continue;
    byFam.set(a.family, [...(byFam.get(a.family) ?? []), last.ok]);
  }
  return [...byFam].filter(([, oks]) => oks.length && oks.every((ok) => !ok)).map(([f]) => f);
}

export function limitationsFor(app: App, p: Prefs, down: string[]): string[] {
  const out: string[] = [];
  const un = unavailableSelected(p, app.registry.available);
  if (un.length) out.push(`Not searched: ${un.map((f) => `${famLabel(f)} (${app.registry.reasons[f] ?? 'unavailable'})`).join('; ')}.`);
  for (const f of down) out.push(`${famLabel(f)} failed to refresh, so recent records from that source may be missing.`);
  if (p.cats.includes('fitness')) out.push('Fitness and wellness businesses rarely appear in public records, so coverage depends mostly on announcements and reporting.');
  return out;
}
const famLabel = (f: string) => f.replace('_', ' ').replace(/^\w/, (m) => m.toUpperCase());

const memDaily = new Map<string, { day: string; n: number }>();
function dailyCount(ipKey: string, now: number, inc: number) {
  const day = new Date(now).toISOString().slice(0, 10);
  const e = memDaily.get(ipKey);
  const cur = e && e.day === day ? e.n : 0;
  memDaily.set(ipKey, { day, n: cur + inc });
  return cur;
}

export async function startPreview(app: App, d: Draft, ipKey: string, opts: { timeoutMs?: number; sync?: boolean } = {}): Promise<Preview> {
  const blockers = previewBlockers(app, d);
  if (blockers.length) throw new UserError(blockers[0]);
  const prefs = d.prefs!;
  const key = prefsKey(prefs);
  const snap = await currentSnapshot(app);
  const cached = await app.store.findReadyPreview(d.id, key, snap.id);
  if (cached) { d.currentPreviewId = cached.id; await app.store.saveDraft(d); return { ...cached, cached: true }; }
  if (d.gens >= PREVIEW_LIMITS.perDraft) throw new UserError(`You've used all ${PREVIEW_LIMITS.perDraft} sample generations for this draft. Your settings are saved. Creating an account does not reset this limit.`);
  if (dailyCount(ipKey, app.clock.now(), 0) >= PREVIEW_LIMITS.perDay) throw new UserError("You've reached today's sample limit. Your draft is saved; try again tomorrow.");
  const now = app.clock.now();
  const pv: Preview = {
    id: newId('pv'), draftId: d.id, accountId: null, version: (await app.store.countPreviews(d.id)) + 1, prefsKey: key, prefs: structuredClone(prefs),
    snapshotId: snap.id, periodFrom: now - app.cfg.lookbackDays * DAY, periodTo: now, status: 'running', error: null, content: null, issue: null,
    down: [], cached: false, createdAt: now, approvedAt: null, expiresAt: d.expiresAt,
  };
  d.gens++;
  dailyCount(ipKey, now, 1);
  d.currentPreviewId = pv.id;
  await app.store.savePreview(pv);
  await app.store.saveDraft(d);
  const job = generatePreview(app, pv, opts.timeoutMs ?? 20_000).catch(() => undefined);
  if (opts.sync) await job;
  return (await app.store.getPreview(pv.id)) ?? pv;
}

async function generatePreview(app: App, pv: Preview, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), timeoutMs); });
  const work = (async () => {
    const down = await downFamilies(app);
    const { changes } = await currentSnapshot(app);
    const w = { from: pv.periodFrom, to: pv.periodTo, field: 'observedAt' as const };
    const content = buildContent(changes, pv.prefs, w, app.registry.available, down);
    const { issue, errors } = await structure(app, 'sample', content, changes, pv.prefs, w.from, w.to, down);
    return { content, issue, errors, down };
  })();
  try {
    const r = await Promise.race([work, timeout]);
    const fresh = (await app.store.getPreview(pv.id)) ?? pv;
    if (r === 'timeout') {
      Object.assign(fresh, { status: 'timeout', error: 'Generation timed out. Nothing was created.' });
      await refundGeneration(app, pv.draftId);
    } else if (r.errors.length) {
      Object.assign(fresh, { status: 'failed', error: 'A citation check failed, so we did not show this sample.' });
      app.log('preview.validation_failed', { preview: pv.id, errors: r.errors.length });
      await refundGeneration(app, pv.draftId);
    } else Object.assign(fresh, { status: 'ready', content: r.content, issue: r.issue, down: r.down });
    await app.store.savePreview(fresh);
  } catch (e) {
    const fresh = (await app.store.getPreview(pv.id)) ?? pv;
    Object.assign(fresh, { status: 'failed', error: 'Sources could not be read, so no sample was created.' });
    await app.store.savePreview(fresh);
    await refundGeneration(app, pv.draftId);
    app.log('preview.error', { preview: pv.id, error: (e as Error).message.slice(0, 200) });
  } finally { clearTimeout(timer); }
}

async function refundGeneration(app: App, draftId: string | null) {
  if (!draftId) return;
  const d = await app.store.getDraft(draftId);
  if (d && d.gens > 0) { d.gens--; await app.store.saveDraft(d); }
}

/** Build and validate a structured issue from approved changes. Shared by previews and weekly issues. */
export async function structure(app: App, kind: 'sample' | 'weekly', content: ReturnType<typeof buildContent>, changes: import('../domain/types.ts').ChangeEvent[], prefs: Prefs, from: number, to: number, down: string[]) {
  const byId = new Map(changes.map((c) => [c.id, c]));
  const ids = [...content.main, ...content.briefs].flatMap((i) => byId.get(i.id)?.evidenceIds ?? []);
  const obs = await app.store.getObservations(ids);
  const evidence = new Map<string, EvidenceRef>(obs.map((o) => [o.id, { id: o.id, title: o.title, url: o.url, recordId: o.recordId, family: o.family, publishedAt: o.publishedAt, observedAt: o.observedAt }]));
  // Reminders reuse the evidence of the original announcement.
  const issue = buildIssue(kind, content, byId, evidence, prefs, {
    from, to, tz: app.cfg.tz, limitations: limitationsFor(app, prefs, down), fixture: app.cfg.mode === 'fixture',
    coverageOk: effectiveFams(prefs, app.registry.available).filter((f) => !down.includes(f)).length,
  });
  return { issue, errors: validateIssue(issue, byId, evidence) };
}

export async function approvePreview(app: App, d: Draft, previewId: string) {
  const pv = await app.store.getPreview(previewId);
  if (!pv || pv.draftId !== d.id) throw new UserError('That sample is not part of this draft.');
  if (pv.status !== 'ready') throw new UserError('That sample is not ready.');
  if (!pv.content?.main.length) throw new UserError("An empty sample can't start a trial. Change your settings or join the waitlist.");
  if (!d.prefs || pv.prefsKey !== prefsKey(d.prefs)) throw new UserError('Your settings changed since this sample. Regenerate it, then approve the new version.');
  pv.approvedAt = app.clock.now();
  d.approvedPreviewId = pv.id;
  await app.store.savePreview(pv);
  await app.store.saveDraft(d);
  return pv;
}

/** The approved preview, only if it still matches the current settings. */
export async function approvedPreview(app: App, d: Draft): Promise<Preview | null> {
  if (!d.approvedPreviewId || !d.prefs) return null;
  const pv = await app.store.getPreview(d.approvedPreviewId);
  return pv && pv.prefsKey === prefsKey(d.prefs) ? pv : null;
}

/* ---------- refinement ---------- */
export interface RefinePlan { ops: PrefOp[]; diff: DiffRow[]; clarify: { q: string; opts: { t: string; ops: PrefOp[] }[] } | null; message: string | null }

export async function planRefinement(app: App, prefs: Prefs, text: string): Promise<RefinePlan> {
  const t = text.trim();
  if (!t) return { ops: [], diff: [], clarify: null, message: 'Type what you would like changed.' };
  const hoods = await knownNeighborhoods(app, prefs.center);
  const r = parseRefine(t, prefs, hoods);
  let ops = r.ops;
  let clarify = r.clarify;
  const notes: string[] = [];
  if (r.geoText) {
    const g = parseGeo(r.geoText, hoods);
    const res = await resolveIntents(app, g.intents, prefs.center);
    ops = ops.concat(res.proposals.map((p: Proposal) => ({ k: 'addShape' as const, mode: p.mode, shape: { ...p.shape, label: p.shape.label.replace(/ \(suggested boundary\)| \(straight line[^)]*\)/, '') } })));
    if (res.clarify) {
      const road = res.clarify.road;
      clarify = { q: `Which stretch of ${road} should we ${res.clarify.mode}? Enter cross streets in the area editor, or pick a size.`, opts: [] };
      notes.push(`We never treat "${road}" as its whole length. Use the street segment tool in the area editor to choose the stretch.`);
    }
    if (res.fails.length) notes.push(`Couldn't place: ${res.fails.join('; ')}.`);
  }
  if (!ops.length && !clarify) return { ops: [], diff: [], clarify: null, message: notes.join(' ') || "We couldn't turn that into a settings change. Try a suggestion, or edit settings directly." };
  return { ops, diff: diffPrefs(prefs, applyOps(prefs, ops)), clarify: clarify && clarify.opts.length ? clarify : null, message: notes.join(' ') || null };
}

export async function applyRefinement(app: App, d: Draft, ops: PrefOp[]) {
  const p = requirePrefs(d);
  const next = applyOps(p, ops);
  const errs = validatePrefs(next);
  if (errs.length) throw new UserError(errs[0]);
  d.prefs = next;
  d.approvedPreviewId = null;
  await app.store.saveDraft(d);
}
