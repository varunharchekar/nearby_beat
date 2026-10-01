import type { Cat, Prefs, Pt, Stage } from './types.ts';

export const CATS: { id: Cat; name: string; ex: string }[] = [
  { id: 'food', name: 'Restaurants and drinks', ex: 'Restaurants, coffee, bakeries, bars, food halls' },
  { id: 'shops', name: 'Shops and everyday services', ex: 'Retail, groceries, salons, neighborhood services' },
  { id: 'fitness', name: 'Fitness and wellness', ex: 'Gyms, studios, spas, wellness businesses' },
  { id: 'dev', name: 'Buildings and development', ex: 'Apartments, offices, hotels, major renovations, demolition' },
  { id: 'public', name: 'Public spaces and infrastructure', ex: 'Parks, sidewalks, road work, transit, bike lanes' },
  { id: 'events', name: 'Openings and launch events', ex: 'Grand openings, soft openings, opening-related events' },
];
export const catName = (c: string) => CATS.find((x) => x.id === c)?.name ?? c;

export type Tier = 'ann' | 'bal' | 'deep';
export interface Family { id: string; name: string; tier: Tier; record: boolean }
/** Source families from the PRD. Whether each works is decided at runtime by the adapter registry. */
export const FAMILIES: Family[] = [
  { id: 'local_reporting', name: 'Local reporting', tier: 'ann', record: false },
  { id: 'company', name: 'Company announcements', tier: 'ann', record: false },
  { id: 'websites', name: 'Public websites', tier: 'ann', record: false },
  { id: 'jobs', name: 'Job postings', tier: 'ann', record: false },
  { id: 'permits', name: 'Building permits', tier: 'bal', record: true },
  { id: 'occupancy', name: 'Certificates of occupancy', tier: 'bal', record: true },
  { id: 'business_reg', name: 'Business registrations', tier: 'bal', record: true },
  { id: 'alcohol', name: 'Alcohol permit applications and licenses', tier: 'bal', record: true },
  { id: 'planning', name: 'Planning applications', tier: 'deep', record: true },
  { id: 'zoning', name: 'Zoning cases and amendments', tier: 'deep', record: true },
  { id: 'ordinances', name: 'Ordinances', tier: 'deep', record: true },
  { id: 'agendas', name: 'Council and board agendas', tier: 'deep', record: true },
];
export const famName = (id: string) => FAMILIES.find((f) => f.id === id)?.name ?? id;

export const PRESETS: Record<Tier, { name: string; tiers: Tier[]; desc: string }> = {
  ann: { name: 'Announcements', tiers: ['ann'], desc: 'Local reporting, company announcements, public websites and job postings. Mostly changes that have already been announced.' },
  bal: { name: 'Balanced research', tiers: ['ann', 'bal'], desc: 'Adds building permits, occupancy records, and business and alcohol registrations where supported. Earlier signals, each labeled by evidence.' },
  deep: { name: 'Deep research', tiers: ['ann', 'bal', 'deep'], desc: 'Adds planning applications, zoning cases, ordinances, agendas and amendments. Proposed changes with longer lead times.' },
};
export const presetFams = (p: Tier) => FAMILIES.filter((f) => PRESETS[p].tiers.includes(f.tier)).map((f) => f.id);
export const presetMap = (p: Tier) => Object.fromEntries(FAMILIES.map((f) => [f.id, PRESETS[p].tiers.includes(f.tier)]));

export const LENS = {
  brief: { name: 'Brief', main: 4, brief: 0 },
  standard: { name: 'Standard', main: 8, brief: 5 },
  detailed: { name: 'Detailed', main: 12, brief: 5 },
} as const;

export const STAGE_RANK: Record<Stage, number> = { signal: 0, announced: 1, filed: 1, approved: 2, construction: 3, open: 4, closed: 4 };
export const STATUS_OPTS = [
  { v: '', t: 'No minimum (show every verified stage)' },
  { v: 'approved:records', t: 'Records only when approved or later (hide filings)' },
  { v: 'approved:all', t: 'Everything approved or later' },
  { v: 'construction:all', t: 'Under construction or later' },
  { v: 'open:all', t: 'Open or closed only' },
];
export const statusText = (v: string) => STATUS_OPTS.find((o) => o.v === (v || ''))?.t ?? v;
export const RADII = [0.5, 1, 2, 5];

export function defaultPrefs(center: Pt, addressLabel: string, areaName: string): Prefs {
  return {
    center, addressLabel, areaName, radiusMi: 1, areaMode: 'radius', inc: [], exc: [],
    cats: CATS.map((c) => c.id), evAll: false, preset: 'bal', fams: presetMap('bal'), len: 'standard', statusMin: '',
  };
}

export const selectedFams = (p: Prefs) => FAMILIES.filter((f) => p.fams[f.id]).map((f) => f.id);
export const effectiveFams = (p: Prefs, available: Set<string>) => selectedFams(p).filter((f) => available.has(f));
export const unavailableSelected = (p: Prefs, available: Set<string>) => selectedFams(p).filter((f) => !available.has(f));

export function depthLabel(p: Prefs): string {
  const s = selectedFams(p);
  for (const t of ['ann', 'bal', 'deep'] as Tier[]) {
    const a = presetFams(t);
    if (a.length === s.length && a.every((x) => s.includes(x))) return PRESETS[t].name;
  }
  return 'Custom';
}

/** Stable key for caching and approval binding. */
export function prefsKey(p: Prefs): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, norm((v as any)[k])]));
    return v;
  };
  return JSON.stringify(norm({ ...p, cats: [...p.cats].sort() }));
}

export function validatePrefs(p: Prefs): string[] {
  const e: string[] = [];
  if (!p.cats.length) e.push('Choose at least one kind of change.');
  if (!RADII.includes(p.radiusMi)) e.push('Choose a radius of 0.5, 1, 2 or 5 miles.');
  if (!(p.len in LENS)) e.push('Choose a newsletter length.');
  if (!STATUS_OPTS.some((o) => o.v === (p.statusMin || ''))) e.push('Unknown status filter.');
  for (const s of [...p.inc, ...p.exc]) {
    if (s.kind === 'poly' && s.coords.length < 3) e.push(`Shape "${s.label}" needs at least 3 points.`);
    if (s.kind === 'corridor' && (s.coords.length < 2 || !(s.widthM && s.widthM > 0))) e.push(`Street segment "${s.label}" is incomplete.`);
  }
  return e;
}

export type DiffRow = [string, string, string];
export function diffPrefs(a: Prefs, b: Prefs): DiffRow[] {
  const rows: DiffRow[] = [];
  const add = (k: string, x: string, y: string) => { if (x !== y) rows.push([k, x, y]); };
  add('Location', a.addressLabel, b.addressLabel);
  add('Radius', `${a.radiusMi} mi`, `${b.radiusMi} mi`);
  add('Interests', a.cats.map(catName).join(', ') || 'None', b.cats.map(catName).join(', ') || 'None');
  const ev = (p: Prefs) => (p.evAll ? 'Events across all categories' : 'Events for selected categories');
  add('Event scope', ev(a), ev(b));
  const sh = (p: Prefs) => (p.areaMode === 'custom' ? [...p.inc.map((s) => `+ ${s.label}`), ...p.exc.map((s) => `− ${s.label}`)].join('; ') || 'Custom, no shapes' : 'Radius only');
  add('Area', sh(a), sh(b));
  add('Research depth', depthLabel(a), depthLabel(b));
  if (depthLabel(a) === 'Custom' && depthLabel(b) === 'Custom') add('Sources', selectedFams(a).map(famName).join(', '), selectedFams(b).map(famName).join(', '));
  add('Length', LENS[a.len].name, LENS[b.len].name);
  add('Minimum status', statusText(a.statusMin), statusText(b.statusMin));
  return rows;
}

export type PrefOp =
  | { k: 'cats'; v: Cat[] } | { k: 'len'; v: Prefs['len'] } | { k: 'radiusMi'; v: number }
  | { k: 'preset'; v: Tier } | { k: 'statusMin'; v: string } | { k: 'evAll'; v: boolean }
  | { k: 'addShape'; mode: 'include' | 'exclude'; shape: import('./types.ts').Shape };

export function applyOps(p: Prefs, ops: PrefOp[]): Prefs {
  const n: Prefs = structuredClone(p);
  for (const o of ops) {
    if (o.k === 'preset') { n.preset = o.v; n.fams = presetMap(o.v); }
    else if (o.k === 'addShape') { n.areaMode = 'custom'; (o.mode === 'exclude' ? n.exc : n.inc).push(o.shape); }
    else (n as any)[o.k] = o.v;
  }
  return n;
}
