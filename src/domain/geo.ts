import type { Geom, Prefs, Pt, Shape } from './types.ts';

export const M_PER_MI = 1609.344;
const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in meters. */
export function geodesic(a: Pt, b: Pt): number {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Local equirectangular projection (meters) around an origin. Accurate to well under 1% within 20 km. */
export function projector(origin: Pt) {
  const k = Math.cos(rad(origin[1]));
  return {
    fwd: (p: Pt): [number, number] => [R * rad(p[0] - origin[0]) * k, R * rad(p[1] - origin[1])],
    inv: (x: number, y: number): Pt => [origin[0] + (x / (R * k)) * (180 / Math.PI), origin[1] + (y / R) * (180 / Math.PI)],
  };
}

type XY = [number, number];
const d2 = (a: XY, b: XY) => Math.hypot(a[0] - b[0], a[1] - b[1]);
function segDist(p: XY, a: XY, b: XY): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return d2(p, [a[0] + t * dx, a[1] + t * dy]);
}
function lineDist(p: XY, pts: XY[]): number {
  let m = Infinity;
  for (let i = 1; i < pts.length; i++) m = Math.min(m, segDist(p, pts[i - 1], pts[i]));
  if (pts.length === 1) m = d2(p, pts[0]);
  return m;
}
function pip(p: XY, poly: XY[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function edgeDist(p: XY, poly: XY[]): number {
  let m = Infinity;
  for (let i = 0; i < poly.length; i++) m = Math.min(m, segDist(p, poly[i], poly[(i + 1) % poly.length]));
  return m;
}

const EDGE_TOL_M = 0.5;

export interface Area { center: Pt; rM: number; inc: Shape[]; exc: Shape[] }

export function areaOf(p: Pick<Prefs, 'center' | 'radiusMi' | 'areaMode' | 'inc' | 'exc'>): Area {
  const custom = p.areaMode === 'custom';
  return { center: p.center, rM: p.radiusMi * M_PER_MI, inc: custom ? p.inc : [], exc: custom ? p.exc : [] };
}

/**
 * Boundary rule: points on the circle or an inclusion edge are inside.
 * Exclusions apply to their interior and always win.
 */
export function makeMatcher(a: Area) {
  const pr = projector(a.center);
  const shp = (s: Shape) => ({ kind: s.kind, w: s.widthM ?? 150, pts: s.coords.map(pr.fwd) });
  const inc = a.inc.map(shp), exc = a.exc.map(shp);
  const inShape = (q: XY, s: ReturnType<typeof shp>, strict: boolean) => {
    if (s.kind === 'corridor') {
      const d = lineDist(q, s.pts);
      return strict ? d < s.w - EDGE_TOL_M : d <= s.w + EDGE_TOL_M;
    }
    if (strict) return pip(q, s.pts) && edgeDist(q, s.pts) > EDGE_TOL_M;
    return pip(q, s.pts) || edgeDist(q, s.pts) <= EDGE_TOL_M;
  };
  const insideXY = (q: XY) => {
    const base = Math.hypot(q[0], q[1]) <= a.rM + EDGE_TOL_M || inc.some((s) => inShape(q, s, false));
    return base && !exc.some((s) => inShape(q, s, true));
  };
  return {
    inside: (p: Pt) => insideXY(pr.fwd(p)),
    insideXY,
    proj: pr,
    incXY: inc,
  };
}

/** Match a change geometry to an area. Lines qualify when any part intersects. */
export function matchGeom(g: Geom | null | undefined, a: Area): { dist: number; partly: boolean } | null {
  if (!g) return null;
  const m = makeMatcher(a);
  if (g.type === 'Point') {
    return m.inside(g.coordinates) ? { dist: geodesic(a.center, g.coordinates), partly: false } : null;
  }
  const samples: Pt[] = [];
  const c = g.coordinates;
  for (let i = 1; i < c.length; i++) {
    const segM = geodesic(c[i - 1], c[i]);
    const n = Math.max(2, Math.ceil(segM / 25));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      samples.push([c[i - 1][0] + (c[i][0] - c[i - 1][0]) * t, c[i - 1][1] + (c[i][1] - c[i - 1][1]) * t]);
    }
  }
  const ins = samples.filter(m.inside);
  if (!ins.length) return null;
  return { dist: Math.min(...ins.map((p) => geodesic(a.center, p))), partly: ins.length < samples.length };
}

/** Approximate effective area in square miles by grid sampling. */
export function areaSqMi(a: Area, n = 140): number {
  const m = makeMatcher(a);
  let minX = -a.rM, minY = -a.rM, maxX = a.rM, maxY = a.rM;
  for (const s of m.incXY) for (const q of s.pts) {
    const w = s.kind === 'corridor' ? s.w : 0;
    minX = Math.min(minX, q[0] - w); minY = Math.min(minY, q[1] - w);
    maxX = Math.max(maxX, q[0] + w); maxY = Math.max(maxY, q[1] + w);
  }
  const w = (maxX - minX) / n, h = (maxY - minY) / n;
  let hits = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    if (m.insideXY([minX + (i + 0.5) * w, minY + (j + 0.5) * h])) hits++;
  }
  return (hits * w * h) / (M_PER_MI * M_PER_MI);
}

export const AREA_LIMIT_SQMI = Math.PI * 25;

/** True if any added shape reaches beyond the base radius. */
export function extendsBeyondRadius(a: Area): boolean {
  return a.inc.some((s) => s.coords.some((p) => geodesic(a.center, p) > a.rM + (s.kind === 'corridor' ? s.widthM ?? 150 : 0)));
}

/** Half-plane polygon bounded by a horizontal or vertical line through a reference point. */
export function halfPlane(dir: 'north' | 'south' | 'east' | 'west', ref: Pt, spanDeg = 0.5): Pt[] {
  const [x, y] = ref, s = spanDeg;
  switch (dir) {
    case 'north': return [[x - s, y], [x + s, y], [x + s, y + s], [x - s, y + s]];
    case 'south': return [[x - s, y - s], [x + s, y - s], [x + s, y], [x - s, y]];
    case 'east': return [[x, y - s], [x + s, y - s], [x + s, y + s], [x, y + s]];
    case 'west': return [[x - s, y - s], [x, y - s], [x, y + s], [x - s, y + s]];
  }
}

export function bboxPolygon(b: [number, number, number, number]): Pt[] {
  return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  const pr = projector(p);
  return pip([0, 0], poly.map(pr.fwd));
}

export const metersToMiles = (m: number) => m / M_PER_MI;
