/** Anonymous onboarding: drafts, location, area editing and refinement. */
import type { App } from '../app.ts';
import type { Prefs, Pt, Shape } from '../domain/types.ts';
import type { Draft } from '../store/types.ts';
import { applyOps, defaultPrefs, diffPrefs, effectiveFams, famName, prefsKey, unavailableSelected, validatePrefs } from '../domain/prefs.ts';
import type { DiffRow, PrefOp } from '../domain/prefs.ts';
import { parseGeo, parseRefine } from '../domain/parse.ts';
import { areaOf, areaSqMi, AREA_LIMIT_SQMI } from '../domain/geo.ts';
import { DAY } from '../domain/time.ts';
import { newId, randomToken, sha256 } from '../lib/crypto.ts';
import { findAddress, inCoverage, nearestNeighborhood, resolveIntents } from './geo.ts';
import type { Proposal } from './geo.ts';

export const DRAFT_TTL = DAY;
export class UserError extends Error {}

export async function createDraft(app: App): Promise<{ draft: Draft; token: string }> {
  const token = randomToken();
  const now = app.clock.now();
  const draft: Draft = { id: newId('drf'), tokenHash: sha256(token), createdAt: now, expiresAt: now + DRAFT_TTL, candidates: null, prefs: null, ack: false, runs: 0, currentReportId: null, proposals: [], geoNote: null, clarify: null };
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
  d.proposals = [];
  d.candidates = null;
  await app.store.saveDraft(d);
  return { covered: true };
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

/** Everything that must be true before a report can be generated. */
export function reportBlockers(app: App, d: Draft): string[] {
  if (!d.prefs) return ['Confirm your location first.'];
  const b = validatePrefs(d.prefs);
  if (d.proposals.length) b.push('Apply or discard the proposed area changes first.');
  if (d.clarify) b.push(`Choose which stretch of ${d.clarify.road} you meant, or dismiss the question.`);
  if (areaCheck(d.prefs).over) b.push('Your area is larger than the launch limit (a 5-mile circle). Remove or shrink a shape.');
  if (unavailableSelected(d.prefs, app.registry.available).length && !d.ack) b.push('Confirm that you want to continue with the available sources.');
  if (!effectiveFams(d.prefs, app.registry.available).length) b.push('Turn on at least one available source.');
  return b;
}

/* ---------- source health ---------- */
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
const famLabel = (f: string) => famName(f);

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
  return { ops, diff: diffPrefs(prefs, applyOps(prefs, ops), app.cfg.research.sources), clarify: clarify && clarify.opts.length ? clarify : null, message: notes.join(' ') || null };
}

export async function applyRefinement(app: App, d: Draft, ops: PrefOp[]) {
  const p = requirePrefs(d);
  const next = applyOps(p, ops);
  const errs = validatePrefs(next);
  if (errs.length) throw new UserError(errs[0]);
  d.prefs = next;
  await app.store.saveDraft(d);
}
