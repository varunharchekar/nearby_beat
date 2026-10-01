/**
 * Natural-language parsing for area and preference edits.
 * Parsing only produces intents. Geography is resolved to shapes later (by a geocoder) and
 * always shown as a proposal the user must confirm. Nothing here applies a change.
 */
import type { Cat, Prefs } from './types.ts';
import type { PrefOp } from './prefs.ts';

export type GeoTarget =
  | { kind: 'neighborhood'; name: string }
  | { kind: 'direction'; dir: 'north' | 'south' | 'east' | 'west'; road: string }
  | { kind: 'segment'; road: string; from: string; to: string }
  | { kind: 'road'; road: string };
export interface GeoIntent { mode: 'include' | 'exclude'; target: GeoTarget; text: string }

const STREET_SUFFIX = /\b(ave|avenue|st|street|ln|lane|rd|road|blvd|boulevard|pkwy|parkway|expy|expressway|fwy|freeway|dr|drive|way|trl|trail|hwy|highway)\.?\b/i;
const clean = (s: string) => s.replace(/\b(everything|anything|the|area|part|stretch|of|this|that|all)\b/gi, ' ').replace(/[^\w\s&'.-]/g, ' ').replace(/\s+/g, ' ').trim();

export function parseGeo(text: string, knownNeighborhoods: string[] = []): { intents: GeoIntent[]; fails: string[] } {
  const clauses = text.split(/\bbut\b|;|,|\.(?=\s|$)/i).map((s) => s.trim()).filter(Boolean);
  let mode: 'include' | 'exclude' = 'include';
  const intents: GeoIntent[] = [];
  const fails: string[] = [];
  for (const c of clauses) {
    const l = c.toLowerCase();
    if (/exclud|remove|except|skip|leave out|drop|\bnot\b|\bno\b|without/.test(l)) mode = 'exclude';
    else if (/includ|\badd\b|\bplus\b|cover|extend/.test(l)) mode = 'include';
    const body = l.replace(/^(and\s+)?(please\s+)?(also\s+)?(include|exclude|add|remove|skip|drop|cover|extend to|leave out|except|without|no)\b/, '').trim();
    let m = body.match(/(north|south|east|west)\s+of\s+(.+)/);
    if (m) { const road = clean(m[2]); if (road) { intents.push({ mode, target: { kind: 'direction', dir: m[1] as any, road }, text: c }); continue; } }
    m = body.match(/(.+?)\s+(?:from|between)\s+(.+?)\s+(?:to|and)\s+(.+)/);
    if (m) { const road = clean(m[1]); if (road) { intents.push({ mode, target: { kind: 'segment', road, from: clean(m[2]), to: clean(m[3]) }, text: c }); continue; } }
    const name = clean(body);
    if (!name) { fails.push(c); continue; }
    const hood = knownNeighborhoods.find((n) => name.includes(n.toLowerCase()));
    if (hood) { intents.push({ mode, target: { kind: 'neighborhood', name: hood }, text: c }); continue; }
    if (STREET_SUFFIX.test(name) || /\bstretch\b/.test(l)) { intents.push({ mode, target: { kind: 'road', road: name.replace(STREET_SUFFIX, '').trim() || name }, text: c }); continue; }
    // A bare name could be a neighborhood or a street; resolve as a neighborhood, and ask if it fails.
    intents.push({ mode, target: { kind: 'neighborhood', name }, text: c });
  }
  return { intents, fails };
}

const CAT_WORDS: Record<Cat, RegExp> = {
  food: /food|restaurant|dining|coffee|\bbars?\b|drink|bakery|cafe/,
  shops: /shop|retail|store|grocer|salon/,
  fitness: /fitness|gym|wellness|yoga|pilates|spa\b/,
  dev: /development|buildings?\b|apartment|housing|hotel|office/,
  public: /infrastructure|park|road work|sidewalk|transit|bike|street work/,
  events: /\bevents?\b|openings?\b/,
};
const catsIn = (s: string) => (Object.keys(CAT_WORDS) as Cat[]).filter((k) => CAT_WORDS[k].test(s));
const GEO_WORDS = /\b(north|south|east|west)\s+of\b|\bstretch\b|\bstreet\b|\bavenue\b|\bave\b|\bblvd\b|\bneighborhood\b/;

export interface RefineResult {
  ops: PrefOp[];
  clarify: { q: string; opts: { t: string; ops: PrefOp[] }[] } | null;
  geoText: string | null;
}

/** Turn a free-text refinement into explicit settings operations. The caller shows a diff before applying. */
export function parseRefine(text: string, p: Prefs, knownNeighborhoods: string[] = []): RefineResult {
  const l = text.toLowerCase();
  const ops: PrefOp[] = [];
  let clarify: RefineResult['clarify'] = null;
  const hasGeo = GEO_WORDS.test(l) || knownNeighborhoods.some((n) => l.includes(n.toLowerCase()));

  const only = l.match(/\bonly\s+(.+)/);
  if (only && !/permit|construction is|approved/.test(only[1])) { const cs = catsIn(only[1]); if (cs.length) ops.push({ k: 'cats', v: cs }); }
  const drop = l.match(/\b(no|without|drop|stop|fewer|remove)\s+([a-z ]+)/);
  if (drop && !hasGeo) { const cs = catsIn(drop[2]); if (cs.length) ops.push({ k: 'cats', v: p.cats.filter((x) => !cs.includes(x)) }); }
  const add = l.match(/\b(add|include|also)\s+([a-z ]+)/);
  if (add && !hasGeo) { const cs = catsIn(add[2]); if (cs.length) ops.push({ k: 'cats', v: [...new Set([...p.cats, ...cs])] }); }

  if (/less detail|shorter|more concise|\bbrief\b/.test(l)) ops.push({ k: 'len', v: p.len === 'detailed' ? 'standard' : 'brief' });
  if (/more detail|longer|\bdetailed\b/.test(l)) ops.push({ k: 'len', v: p.len === 'brief' ? 'standard' : 'detailed' });

  const rm = l.match(/(0?\.5|half|\b1\b|\b2\b|\b5\b|one|two|five)\s*-?\s*(mi|mile)/);
  const R: Record<string, number> = { '.5': 0.5, '0.5': 0.5, half: 0.5, '1': 1, one: 1, '2': 2, two: 2, '5': 5, five: 5 };
  if (rm && R[rm[1]]) ops.push({ k: 'radiusMi', v: R[rm[1]] });
  else if (/widen|bigger area|wider|farther|further out/.test(l)) clarify = { q: 'How far should the radius reach?', opts: [{ t: '2 miles', ops: [{ k: 'radiusMi', v: 2 }] }, { t: '5 miles', ops: [{ k: 'radiusMi', v: 5 }] }] };

  if (/deep(er)? research|dig deeper|zoning|planning/.test(l)) ops.push({ k: 'preset', v: 'deep' });
  if (/announcements only|less digging|just announcements/.test(l)) ops.push({ k: 'preset', v: 'ann' });
  if (/permit/.test(l) && /approved|construction/.test(l)) ops.push({ k: 'statusMin', v: /under construction|construction (has )?start/.test(l) ? 'construction:all' : 'approved:records' });
  if (/events across|all events/.test(l)) ops.push({ k: 'evAll', v: true });

  return { ops, clarify, geoText: hasGeo ? text : null };
}
