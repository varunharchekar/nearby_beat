/** Coverage checks and resolution of parsed geography intents into proposed shapes. */
import type { App } from '../app.ts';
import type { Pt, Shape } from '../domain/types.ts';
import type { GeoIntent } from '../domain/parse.ts';
import { bboxPolygon, geodesic, halfPlane } from '../domain/geo.ts';
import type { GeoCandidate } from '../store/types.ts';
import { newId } from '../lib/crypto.ts';

export function inCoverage(app: App, p: Pt): boolean {
  const [x0, y0, x1, y1] = app.cfg.coverage.bbox;
  return p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
}

export async function findAddress(app: App, q: string, near?: Pt): Promise<GeoCandidate[]> {
  const res = await app.geocoder.search(q, { types: ['address', 'intersection', 'street', 'postcode'], proximity: near ?? centerOf(app), limit: 5 });
  return res.map((r) => ({ id: newId('cand'), label: r.label, city: r.city, point: r.point, kind: r.kind, covered: inCoverage(app, r.point), approx: r.approx }));
}

export function centerOf(app: App): Pt {
  const [x0, y0, x1, y1] = app.cfg.coverage.bbox;
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

export async function nearestNeighborhood(app: App, p: Pt): Promise<string> {
  try {
    const n = await app.geocoder.neighborhood?.(p);
    if (n && geodesic(n.point, p) < 8000) return n.label;
  } catch { /* fall through */ }
  return 'your address';
}

export interface Proposal { id: string; mode: 'include' | 'exclude'; shape: Shape }
export interface Resolved { proposals: Proposal[]; clarify: { mode: 'include' | 'exclude'; road: string; text: string } | null; fails: string[] }

/** Resolve intents with the geocoder. Results are proposals; the user must confirm each on the map. */
export async function resolveIntents(app: App, intents: GeoIntent[], center: Pt): Promise<Resolved> {
  const out: Resolved = { proposals: [], clarify: null, fails: [] };
  for (const it of intents) {
    const t = it.target;
    try {
      if (t.kind === 'neighborhood') {
        const r = (await app.geocoder.search(t.name, { types: ['neighborhood'], proximity: center, limit: 1 }))[0];
        if (!r?.bbox) { out.fails.push(`${it.text} (no neighborhood boundary found; draw it on the map instead)`); continue; }
        out.proposals.push({ id: newId('prop'), mode: it.mode, shape: { kind: 'poly', coords: bboxPolygon(r.bbox), label: `${r.label} (suggested boundary)` } });
      } else if (t.kind === 'direction') {
        const r = (await app.geocoder.search(t.road, { types: ['street'], proximity: center, limit: 1 }))[0];
        if (!r) { out.fails.push(`${it.text} (street not found)`); continue; }
        const dir = t.dir[0].toUpperCase() + t.dir.slice(1);
        out.proposals.push({ id: newId('prop'), mode: it.mode, shape: { kind: 'poly', coords: halfPlane(t.dir, r.point), label: `${dir} of ${r.label} (straight line through the street near you; check the map)` } });
      } else if (t.kind === 'segment') {
        const [a, b] = await Promise.all([t.from, t.to].map((x) => app.geocoder.search(`${t.road} & ${x}`, { types: ['intersection'], proximity: center, limit: 1 })));
        if (!a[0] || !b[0]) { out.fails.push(`${it.text} (couldn't find both cross streets)`); continue; }
        out.proposals.push({ id: newId('prop'), mode: it.mode, shape: { kind: 'corridor', coords: [a[0].point, b[0].point], widthM: 150, label: `${a[0].label.split('&')[0].trim()}, ${a[0].label.split('&')[1]?.trim() ?? t.from} to ${b[0].label.split('&')[1]?.trim() ?? t.to}` } });
      } else {
        out.clarify = { mode: it.mode, road: t.road, text: it.text };
      }
    } catch { out.fails.push(`${it.text} (lookup failed)`); }
  }
  return out;
}
