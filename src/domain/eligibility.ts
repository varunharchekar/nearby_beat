import type { ChangeEvent, IssueContent, Prefs } from './types.ts';
import { areaOf, matchGeom } from './geo.ts';
import { effectiveFams, FAMILIES, LENS, STAGE_RANK } from './prefs.ts';

export const RANK: Record<ChangeEvent['type'], number> = {
  opening_event: 0, reminder: 0, opened: 0, timeline: 1, announcement: 2,
  closure: 3, cancellation: 3, construction: 4, status: 4, early: 5,
};

export interface Window { from: number; to: number; field: 'approvedAt' | 'observedAt' }

/** Decide whether one approved change belongs in a subscriber's issue. */
export function eligible(c: ChangeEvent, p: Prefs, w: Window, available: Set<string>, down: string[] = []) {
  if (c.review !== 'approved' || !c.geom) return null;
  const t = c[w.field];
  if (t == null || t <= w.from || t > w.to) return null;
  if (!effectiveFams(p, available).includes(c.family) || down.includes(c.family)) return null;
  const isEvent = c.isEvent || c.type === 'reminder';
  if (isEvent) {
    if (!p.cats.includes('events')) return null;
    if (!p.cats.includes(c.cat) && !p.evAll) return null;
  } else if (!p.cats.includes(c.cat)) return null;
  if (p.statusMin) {
    const [min, scope] = p.statusMin.split(':');
    const isRecord = FAMILIES.find((f) => f.id === c.family)?.record;
    if ((scope === 'all' || isRecord) && STAGE_RANK[c.stage] < STAGE_RANK[min as keyof typeof STAGE_RANK]) return null;
  }
  const m = matchGeom(c.geom, areaOf(p));
  if (!m) return null;
  return { id: c.id, dist: m.dist, partly: m.partly };
}

export function buildContent(changes: ChangeEvent[], p: Prefs, w: Window, available: Set<string>, down: string[] = []): IssueContent {
  const seen = new Set<string>();
  const res = [];
  for (const c of changes) {
    if (seen.has(c.dedupeKey)) continue;
    const r = eligible(c, p, w, available, down);
    if (r) { res.push({ ...r, rank: RANK[c.type] }); seen.add(c.dedupeKey); }
  }
  res.sort((a, b) => a.rank - b.rank || a.dist - b.dist);
  const L = LENS[p.len];
  const strip = ({ rank, ...x }: (typeof res)[number]) => x;
  return { main: res.slice(0, L.main).map(strip), briefs: res.slice(L.main, L.main + L.brief).map(strip), total: res.length };
}
