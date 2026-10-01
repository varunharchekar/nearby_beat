/** Server-rendered SVG map of a subscriber area. Works without JavaScript; app.js adds pin moving and drawing. */
import type { Area } from '../domain/geo.ts';
import { M_PER_MI, projector } from '../domain/geo.ts';
import type { Geom, Pt, Shape } from '../domain/types.ts';
import { esc } from './html.ts';

export interface MapOpts {
  label: string;
  proposals?: { mode: 'include' | 'exclude'; shape: Shape }[];
  pins?: Geom[];
  interactive?: 'pin' | 'draw' | null;
  basemap?: (bbox: [number, number, number, number]) => string | null;
}

let n = 0;
export function mapSvg(a: Area, o: MapOpts): string {
  const id = `m${++n}`;
  const pr = projector(a.center);
  let minX = -a.rM, minY = -a.rM, maxX = a.rM, maxY = a.rM;
  const grow = (p: Pt, w = 0) => { const [x, y] = pr.fwd(p); minX = Math.min(minX, x - w); minY = Math.min(minY, y - w); maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + w); };
  const big = (s: Shape) => s.coords.some((p) => Math.abs(pr.fwd(p)[0]) > 30000 || Math.abs(pr.fwd(p)[1]) > 30000);
  for (const s of a.inc) if (!big(s)) for (const p of s.coords) grow(p, s.kind === 'corridor' ? s.widthM ?? 150 : 0);
  for (const p of o.proposals ?? []) if (p.mode === 'include' && !big(p.shape)) for (const q of p.shape.coords) grow(q, p.shape.widthM ?? 0);
  for (const g of o.pins ?? []) for (const q of g.type === 'Point' ? [g.coordinates] : g.coordinates) grow(q);
  const size = Math.max(maxX - minX, maxY - minY, 1600) * 1.14;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const x0 = cx - size / 2, y0 = -(cy + size / 2);
  const u = size / 420;
  const P = (p: Pt) => { const [x, y] = pr.fwd(p); return `${x.toFixed(1)},${(-y).toFixed(1)}`; };
  const poly = (s: Shape, cls: string, extra = '') => `<polygon class="${cls}" points="${s.coords.map(P).join(' ')}" ${extra}/>`;
  const line = (pts: Pt[], cls: string, w: number, extra = '') => `<polyline class="${cls}" points="${pts.map(P).join(' ')}" stroke-width="${w}" stroke-linecap="round" fill="none" ${extra}/>`;
  const sw = (s: Shape, white: boolean) => s.kind === 'corridor' ? line(s.coords, '', (s.widthM ?? 150) * 2, `stroke="${white ? '#fff' : '#000'}"`) : poly(s, '', `fill="${white ? '#fff' : '#000'}"`);
  const sw0 = pr.inv(x0, -(y0 + size)), ne = pr.inv(x0 + size, -y0);
  const base = o.basemap?.([sw0[0], sw0[1], ne[0], ne[1]]);
  let g = `<defs><pattern id="${id}h" patternUnits="userSpaceOnUse" width="${u * 9}" height="${u * 9}" patternTransform="rotate(45)"><line class="m-hatch" x1="0" y1="0" x2="0" y2="${u * 9}" stroke-width="${u * 2.2}"/></pattern>
  <mask id="${id}k" maskUnits="userSpaceOnUse" x="${x0}" y="${y0}" width="${size}" height="${size}"><rect x="${x0}" y="${y0}" width="${size}" height="${size}" fill="#000"/><circle cx="0" cy="0" r="${a.rM}" fill="#fff"/>${a.inc.map((s) => sw(s, true)).join('')}${a.exc.map((s) => sw(s, false)).join('')}</mask></defs>`;
  g += `<rect class="m-bg" x="${x0}" y="${y0}" width="${size}" height="${size}"/>`;
  if (base) g += `<image href="${esc(base)}" x="${x0}" y="${y0}" width="${size}" height="${size}" preserveAspectRatio="none" opacity="0.9"/>`;
  g += `<rect class="m-eff" x="${x0}" y="${y0}" width="${size}" height="${size}" mask="url(#${id}k)"/>`;
  g += `<circle class="m-circle" cx="0" cy="0" r="${a.rM}" stroke-width="${u * 1.6}" stroke-dasharray="${u * 6} ${u * 4}"/>`;
  for (const s of a.inc) g += s.kind === 'corridor' ? line(s.coords, 'm-inc', u * 1.8, `stroke-dasharray="${u * 3} ${u * 3}"`) : poly(s, 'm-inc', `stroke-width="${u * 1.8}" fill="none"`);
  for (const s of a.exc) g += s.kind === 'corridor' ? line(s.coords, 'm-exc-c', (s.widthM ?? 150) * 2) + line(s.coords, 'm-exc', u * 1.6) : poly(s, 'm-exc', `fill="url(#${id}h)" stroke-width="${u * 1.8}"`);
  for (const p of o.proposals ?? []) g += p.shape.kind === 'corridor' ? line(p.shape.coords, 'm-prop-c', (p.shape.widthM ?? 150) * 2) + line(p.shape.coords, 'm-prop', u * 2.4, `stroke-dasharray="${u * 5} ${u * 3}"`) : poly(p.shape, 'm-prop', `stroke-width="${u * 2.6}" stroke-dasharray="${u * 7} ${u * 4}" fill="none"`);
  (o.pins ?? []).forEach((pg, i) => {
    let q: Pt;
    if (pg.type === 'LineString') { g += line(pg.coordinates, 'm-line', u * 5); q = pg.coordinates[Math.floor(pg.coordinates.length / 2)]; }
    else q = pg.coordinates;
    const [x, y] = pr.fwd(q);
    g += `<circle class="m-pin" cx="${x}" cy="${-y}" r="${u * 8}" stroke-width="${u * 1.5}"/><text class="m-pin-t" x="${x}" y="${-y + u * 3.4}" font-size="${u * 9.5}" text-anchor="middle">${i + 1}</text>`;
  });
  g += `<circle class="m-center-r" cx="0" cy="0" r="${u * 7}" stroke-width="${u * 2}"/><circle class="m-center" cx="0" cy="0" r="${u * 2.6}"/>`;
  const sbMi = size > 12000 ? 2 : size > 6000 ? 1 : 0.5, sb = sbMi * M_PER_MI, sx = x0 + size - u * 14 - sb, sy = y0 + size - u * 14;
  g += `<line class="m-scale" x1="${sx}" y1="${sy}" x2="${sx + sb}" y2="${sy}" stroke-width="${u * 2.4}"/><text class="m-label" x="${sx + sb}" y="${sy - u * 5}" font-size="${u * 8.5}" text-anchor="end">${sbMi} mi</text>`;
  const data = o.interactive ? ` data-mode="${o.interactive}" data-lng="${a.center[0]}" data-lat="${a.center[1]}"` : '';
  return `<svg class="map" viewBox="${x0} ${y0} ${size} ${size}" role="img" aria-label="${esc(o.label)}"${data} xmlns="http://www.w3.org/2000/svg">${g}</svg>`;
}

/** Mapbox Static Images basemap for an exact bbox, when a token is configured. */
export function mapboxStatic(token: string | null) {
  if (!token) return undefined;
  return (b: [number, number, number, number]) => `https://api.mapbox.com/styles/v1/mapbox/light-v11/static/[${b.map((x) => x.toFixed(5)).join(',')}]/640x640@2x?padding=0&attribution=false&logo=false&access_token=${encodeURIComponent(token)}`;
}
