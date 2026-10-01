/**
 * Entity resolution, material change detection and evidence rules.
 * Pure functions: the pipeline feeds them stored state and persists what they return.
 */
import type { ChangeEvent, ChangeType, Entity, EvidenceLabel, ObservationFacts, ReviewState, SourceObservation } from './types.ts';
import { DAY } from './time.ts';

export const normText = (s: string) =>
  s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(llc|inc|co|corp|ltd|the|dba)\b/g, ' ').replace(/\s+/g, ' ').trim();

const normAddr = (s = '') =>
  normText(s).replace(/\bavenue\b/g, 'ave').replace(/\bstreet\b/g, 'st').replace(/\blane\b/g, 'ln')
    .replace(/\broad\b/g, 'rd').replace(/\bboulevard\b/g, 'blvd').replace(/\bdrive\b/g, 'dr')
    .replace(/\b(north)\b/g, 'n').replace(/\b(south)\b/g, 's').replace(/\b(east)\b/g, 'e').replace(/\b(west)\b/g, 'w');

/** Suite is part of identity so unrelated tenants at one address never merge. */
export const entityKey = (f: Pick<ObservationFacts, 'name' | 'address' | 'suite' | 'projectId'>) =>
  f.projectId ? `project|${f.projectId}` : [normText(f.name), normAddr(f.address), normText(f.suite ?? '')].join('|');

function tokenOverlap(a: string, b: string): number {
  const A = new Set(normText(a).split(' ').filter(Boolean));
  const B = new Set(normText(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return n / Math.min(A.size, B.size);
}

export interface Resolution { match: Entity | null; ambiguous: Entity[] }
export function resolveEntity(f: ObservationFacts, entities: Entity[]): Resolution {
  const key = entityKey(f);
  const exact = entities.find((e) => e.key === key);
  if (exact) return { match: exact, ambiguous: [] };
  const sameAddr = entities.filter((e) => f.address && e.address && normAddr(e.address) === normAddr(f.address));
  const ambiguous = sameAddr.filter((e) => tokenOverlap(e.canonicalName, f.name) >= 0.6 && normText(e.suite ?? '') !== normText(f.suite ?? ''));
  return { match: null, ambiguous };
}

export function evidenceLabel(family: string, stage: ObservationFacts['stage']): EvidenceLabel {
  if (family === 'jobs' || stage === 'signal') return 'Early signal';
  if ((family === 'zoning' || family === 'planning' || family === 'agendas') && (stage === 'filed' || stage === 'announced')) return 'Proposal';
  if (family === 'company' || family === 'websites') return 'Owner announcement';
  if (family === 'local_reporting') return 'Attributed report';
  return 'Primary record';
}

export interface PrevState { contentHash: string; facts: ObservationFacts }
export type DraftChange = Omit<ChangeEvent, 'review' | 'reviewReasons'>;

function placeOf(f: ObservationFacts) {
  return [f.address, f.suite ? `Suite ${f.suite}` : ''].filter(Boolean).join(', ') || 'Location from record';
}
function dateOf(f: ObservationFacts) {
  if (f.event) return { text: f.event.text, est: false, at: f.event.at };
  return f.openingDate ?? null;
}

/**
 * Compare a new observation with the previous observation of the same source record.
 * Unchanged or immaterial edits produce nothing. A record that disappears is never treated as a closure.
 */
export function deriveChanges(prev: PrevState | null, obs: SourceObservation, entityId: string, newId: () => string): DraftChange[] {
  const f = obs.facts;
  if (prev && prev.contentHash === obs.contentHash) return [];
  const base = {
    entityId, cat: f.cat, isEvent: !!f.event, stage: f.stage, name: f.name, place: placeOf(f), geom: f.geom ?? null,
    status: f.statusText, summary: f.summary, why: f.why, date: dateOf(f), occurredAt: obs.occurredAt ?? null,
    publishedAt: obs.publishedAt, observedAt: obs.observedAt, approvedAt: null, family: obs.family,
    evidenceIds: [obs.id], evidenceLabel: evidenceLabel(obs.family, f.stage),
  };
  const mk = (type: ChangeType, extra: Partial<DraftChange> = {}): DraftChange => ({
    ...base, ...extra, type, id: newId(),
    dedupeKey: `${entityId}:${type}:${extra.after ?? f.stage}:${base.date?.text ?? ''}`,
  });
  if (!prev) {
    const t: ChangeType = f.canceled ? 'cancellation' : f.closed ? 'closure' : f.event ? 'opening_event'
      : f.stage === 'signal' ? 'early' : f.stage === 'open' ? 'opened' : f.stage === 'construction' ? 'construction'
      : f.stage === 'filed' || f.stage === 'approved' ? 'status' : 'announcement';
    return [mk(t)];
  }
  const p = prev.facts;
  const out: DraftChange[] = [];
  if (f.canceled && !p.canceled) out.push(mk('cancellation', { before: p.statusText, after: f.statusText }));
  else if (f.closed && !p.closed) out.push(mk('closure', { before: p.statusText, after: f.statusText }));
  else if (p.stage !== f.stage) out.push(mk(f.stage === 'open' ? 'opened' : f.stage === 'construction' ? 'construction' : 'status', { before: p.statusText, after: f.statusText }));
  const pd = p.event?.text ?? p.openingDate?.text;
  const nd = f.event?.text ?? f.openingDate?.text;
  if (nd && pd && pd !== nd) out.push(mk(f.event ? 'opening_event' : 'timeline', { before: pd, after: nd }));
  else if (nd && !pd && f.event) out.push(mk('opening_event'));
  if (!out.length && f.revision && p.revision && f.revision !== p.revision) {
    out.push(mk('status', { before: 'Earlier filing', after: `Amended: ${f.statusText}`, status: `Amended filing (${f.statusText})` }));
  }
  return out;
}

/** Different sources giving different dates for the same entity within 45 days. */
export function conflictingWith(recent: ChangeEvent[], c: DraftChange): ChangeEvent[] {
  if (!c.date?.text) return [];
  return recent.filter((r) => r.entityId === c.entityId && r.id !== c.id && r.date?.text && r.family !== c.family
    && r.date.text !== c.date!.text && Math.abs(r.observedAt - c.observedAt) <= 45 * DAY && c.before !== r.date.text);
}

export function detectConflict(recent: ChangeEvent[], c: DraftChange): string[] | null {
  if (!c.date?.text) return null;
  // Only different sources can conflict; a newer report from the same source is an update (a timeline change).
  const others = recent.filter((r) => r.entityId === c.entityId && r.id !== c.id && r.date?.text && r.family !== c.family
    && r.date.text !== c.date!.text && Math.abs(r.observedAt - c.observedAt) <= 45 * DAY && c.before !== r.date.text);
  if (!others.length) return null;
  return [...others.map((o) => `${o.evidenceLabel} (${o.family}): ${o.date!.text}`), `${c.evidenceLabel} (${c.family}): ${c.date.text}`];
}

export function reviewFor(c: DraftChange & { conflict?: string[] }, mode: 'all' | 'flagged', opts: { ambiguousEntity?: boolean } = {}): { review: ReviewState; reasons: string[] } {
  const reasons: string[] = [];
  if (!c.geom) reasons.push('No confirmed location');
  if (c.conflict?.length) reasons.push('Conflicting evidence');
  if (opts.ambiguousEntity) reasons.push('Possible duplicate entity (different suite)');
  if (c.family === 'jobs' && c.type !== 'early') reasons.push('Job posting cannot confirm an opening');
  if (mode === 'all' || reasons.length) return { review: 'needs_review', reasons: reasons.length ? reasons : ['Manual review required'] };
  return { review: 'approved', reasons: [] };
}

/** One imminent reminder for an opening event in the next 14 days, with its own dedupe key. */
export function reminderFor(c: ChangeEvent, now: number, existingKeys: Set<string>, newId: () => string): ChangeEvent | null {
  if (!c.isEvent || c.review !== 'approved' || !c.date?.at) return null;
  if (c.date.at <= now || c.date.at > now + 14 * DAY) return null;
  const key = `${c.entityId}:reminder:${c.date.text}`;
  if (existingKeys.has(key)) return null;
  return {
    ...c, id: newId(), type: 'reminder', dedupeKey: key, status: `${c.date.text}: coming up`,
    summary: `Reminder: ${c.summary}`, why: 'You saw this announcement earlier. This is the one reminder we send before the event.',
    observedAt: now, approvedAt: now, before: undefined, after: undefined,
  };
}
