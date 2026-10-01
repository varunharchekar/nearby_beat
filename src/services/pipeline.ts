/** Ingestion → entity resolution → change derivation → review, plus operator review actions. */
import type { App } from '../app.ts';
import type { SourceAdapter } from '../adapters/types.ts';
import type { ChangeEvent, Entity, ObservationFacts, Pt, SourceObservation } from '../domain/types.ts';
import { conflictingWith, deriveChanges, detectConflict, entityKey, reminderFor, resolveEntity, reviewFor } from '../domain/changes.ts';
import { DAY } from '../domain/time.ts';
import { newId } from '../lib/crypto.ts';
import { inCoverage } from './geo.ts';

export async function geocodeInCoverage(app: App, address: string): Promise<Pt | null> {
  try {
    const r = await app.geocoder.search(address, { types: ['address', 'intersection'], limit: 1 });
    const hit = r.find((x) => !x.approx || x.kind === 'intersection');
    return hit && inCoverage(app, hit.point) ? hit.point : null;
  } catch { return null; }
}

export async function refreshAdapter(app: App, a: SourceAdapter): Promise<{ ok: boolean; count: number; changes: number; error: string | null }> {
  const now = app.clock.now();
  const cursorKey = `cursor:${a.id}`;
  const since = (await app.store.kvGet<number>(cursorKey)) ?? now - 60 * DAY;
  try {
    const obs = await a.fetch({ now, since, fetch: app.fetch, geocode: (q) => geocodeInCoverage(app, q) });
    let changes = 0;
    for (const o of obs) changes += (await ingest(app, o)).length;
    await app.store.kvSet(cursorKey, now);
    await app.store.recordAdapterRun({ adapter: a.id, at: now, ok: true, count: obs.length, error: null });
    app.log('adapter.refresh', { adapter: a.id, observations: obs.length, changes });
    return { ok: true, count: obs.length, changes, error: null };
  } catch (e) {
    const error = (e as Error).message.slice(0, 300);
    await app.store.recordAdapterRun({ adapter: a.id, at: now, ok: false, count: 0, error });
    app.log('adapter.error', { adapter: a.id, error });
    return { ok: false, count: 0, changes: 0, error };
  }
}

export async function refreshAll(app: App) {
  const out: Record<string, Awaited<ReturnType<typeof refreshAdapter>>> = {};
  for (const a of app.registry.adapters) out[a.id] = await refreshAdapter(app, a);
  await createReminders(app);
  return out;
}

/** Store an observation, resolve its entity and record any material change. */
export async function ingest(app: App, o: SourceObservation): Promise<ChangeEvent[]> {
  const now = app.clock.now();
  const prev = await app.store.getObservationState(o.adapter, o.recordId);
  const entities = await app.store.listEntities();
  const res = resolveEntity(o.facts, entities);
  let entity: Entity | null = res.match;
  if (!entity) {
    entity = { id: newId('ent'), key: entityKey(o.facts), type: o.facts.projectId ? 'project' : o.facts.cat === 'public' ? 'public' : 'business', canonicalName: o.facts.name, aliases: [], address: o.facts.address, suite: o.facts.suite, geom: o.facts.geom ?? null, externalIds: [`${o.adapter}:${o.recordId}`] };
  } else {
    if (!entity.externalIds.includes(`${o.adapter}:${o.recordId}`)) entity.externalIds.push(`${o.adapter}:${o.recordId}`);
    if (entity.canonicalName !== o.facts.name && !entity.aliases.includes(o.facts.name)) entity.aliases.push(o.facts.name);
    if (!entity.geom && o.facts.geom) entity.geom = o.facts.geom;
  }
  await app.store.saveEntity(entity);
  const drafts = deriveChanges(prev, o, entity.id, () => newId('chg'));
  await app.store.saveObservation(o, { adapter: o.adapter, recordId: o.recordId, contentHash: o.contentHash, facts: o.facts, lastObservationId: o.id });
  if (!drafts.length) return [];
  const recent = (await app.store.listChanges({ since: now - 60 * DAY })).filter((c) => c.entityId === entity!.id);
  const saved: ChangeEvent[] = [];
  for (const d of drafts) {
    const conflict = detectConflict(recent, d) ?? undefined;
    const r = reviewFor({ ...d, conflict }, app.cfg.reviewMode, { ambiguousEntity: res.ambiguous.length > 0 && !res.match });
    const c: ChangeEvent = { ...d, conflict, review: r.review, reviewReasons: r.reasons, approvedAt: r.review === 'approved' ? now : null };
    if (await app.store.saveChange(c)) saved.push(c);
    // Pull earlier conflicting changes back into review so neither date is sent until an operator decides.
    for (const o of conflictingWith(recent, d)) {
      if (o.review !== 'approved') continue;
      o.review = 'needs_review';
      o.approvedAt = null;
      o.conflict = conflict;
      o.reviewReasons = [...new Set([...o.reviewReasons, 'Conflicting evidence'])];
      await app.store.saveChange(o);
      await app.store.audit({ at: now, actor: 'system', op: 'change.conflict_hold', detail: `${o.name} (${o.id}) held: conflicts with ${c.id}` });
    }
  }
  return saved;
}

export async function createReminders(app: App) {
  const now = app.clock.now();
  const all = await app.store.listChanges({ since: now - 90 * DAY });
  const keys = new Set(all.map((c) => c.dedupeKey));
  let n = 0;
  for (const c of all) {
    const r = reminderFor(c, now, keys, () => newId('chg'));
    if (r && (await app.store.saveChange(r))) { keys.add(r.dedupeKey); n++; }
  }
  return n;
}

/* ---------- operator review ---------- */
async function mustChange(app: App, id: string) {
  const c = await app.store.getChange(id);
  if (!c) throw new Error('Change not found.');
  return c;
}
export async function reviewChange(app: App, id: string, decision: 'approved' | 'rejected', actor: string) {
  const c = await mustChange(app, id);
  if (decision === 'approved' && !c.geom) throw new Error('Set a location before approving.');
  c.review = decision;
  c.approvedAt = decision === 'approved' ? app.clock.now() : null;
  await app.store.saveChange(c);
  await app.store.audit({ at: app.clock.now(), actor, op: `change.${decision === 'approved' ? 'approve' : 'reject'}`, detail: `${c.name} (${c.id})` });
}
export async function correctChange(app: App, id: string, fields: { status?: string; summary?: string; dateText?: string; dateEst?: boolean }, actor: string) {
  const c = await mustChange(app, id);
  const before = JSON.stringify({ status: c.status, summary: c.summary, date: c.date });
  if (fields.status) c.status = fields.status;
  if (fields.summary) c.summary = fields.summary;
  if (fields.dateText != null) c.date = fields.dateText ? { text: fields.dateText, est: !!fields.dateEst, at: null } : null;
  await app.store.saveChange(c);
  await app.store.audit({ at: app.clock.now(), actor, op: 'change.correct', detail: `${c.name} (${c.id}) was ${before}` });
}
export async function locateChange(app: App, id: string, address: string, actor: string) {
  const c = await mustChange(app, id);
  const p = await geocodeInCoverage(app, address);
  if (!p) throw new Error('That address could not be placed inside the coverage area.');
  c.geom = { type: 'Point', coordinates: p };
  c.place = address;
  c.reviewReasons = c.reviewReasons.filter((r) => r !== 'No confirmed location');
  await app.store.saveChange(c);
  await app.store.audit({ at: app.clock.now(), actor, op: 'change.locate', detail: `${c.name} (${c.id}) placed by operator` });
}

/** Manual entry for company announcements and public websites. Goes through the same pipeline. */
export async function manualEntry(app: App, actor: string, e: { family: 'company' | 'websites' | 'local_reporting'; url: string; title: string; publishedAt: number; facts: Omit<ObservationFacts, 'geom'>; address: string }) {
  const geom = await geocodeInCoverage(app, e.address);
  const { observation } = await import('../adapters/types.ts');
  const pseudo = { id: `manual_${e.family}`, family: e.family } as SourceAdapter;
  const o = observation(pseudo, { recordId: e.url, url: e.url, title: e.title, publishedAt: e.publishedAt, observedAt: app.clock.now(), hashOf: [e.facts, e.address], facts: { ...e.facts, address: e.address, geom: geom ? { type: 'Point', coordinates: geom } : null } });
  const saved = await ingest(app, o);
  await app.store.audit({ at: app.clock.now(), actor, op: 'manual.entry', detail: `${e.facts.name}: ${saved.length} change(s)` });
  return saved;
}
