/**
 * Turn the researcher's raw output into a validated report:
 * every item must cite a URL the researcher actually saw, be placed inside the user's area, and pass the filters.
 */
import type { Cat, Geom, Prefs, Pt } from '../domain/types.ts';
import type { IssueItem, StructuredIssue } from '../domain/issue.ts';
import { areaLabelOf } from '../domain/issue.ts';
import { areaOf, matchGeom, metersToMiles } from '../domain/geo.ts';
import { depthLabel, LENS, STAGE_RANK, catName } from '../domain/prefs.ts';
import type { RawItem, RawReport, ResearchResult } from './types.ts';

export interface Dropped { name: string; reason: string }
export interface AssembledReport { issue: StructuredIssue; summary: string; dropped: Dropped[] }

const LABEL: Record<RawItem['evidence_type'], IssueItem['evidenceLabel']> = {
  official_record: 'Primary record', business_announcement: 'Owner announcement', news_report: 'Attributed report', job_posting: 'Early signal', other: 'Attributed report',
};
const RANK: Record<string, number> = { open: 0, closed: 3, construction: 4, approved: 4, filed: 4, announced: 2, signal: 5 };
/** Fallback publisher label from a URL's host, e.g. "dmagazine.com" → "dmagazine.com". */
export function publisherOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'Source'; }
}
const norm = (u: string) => u.replace(/#.*$/, '').replace(/\/$/, '').replace(/^http:/, 'https:').replace('://www.', '://').toLowerCase();

export async function assemble(
  raw: ResearchResult, prefs: Prefs,
  ctx: { geocode: (address: string) => Promise<Pt | null>; from: number; to: number; tz: string; fixture: boolean; limitations: string[]; recordUrls: Set<string>; trustCoords: boolean; depthName?: string },
): Promise<AssembledReport> {
  const seen = new Map([...raw.seenUrls].map(([u, v]) => [norm(u), { url: u, ...v }]));
  const area = areaOf(prefs);
  const dropped: Dropped[] = [];
  const kept: (IssueItem & { _rank: number })[] = [];
  const names = new Set<string>();
  const statusMin = prefs.statusMin ? prefs.statusMin.split(':') : null;

  for (const it of raw.report.items) {
    const sources = it.sources.filter((s) => seen.has(norm(s.url)));
    if (!sources.length) { dropped.push({ name: it.name, reason: 'no source we could verify' }); continue; }
    const key = it.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (names.has(key)) continue;
    // Filters
    const isEvent = !!it.event;
    if (isEvent) {
      if (!prefs.cats.includes('events')) { dropped.push({ name: it.name, reason: 'opening events not selected' }); continue; }
      if (!prefs.cats.includes(it.category) && !prefs.evAll) { dropped.push({ name: it.name, reason: 'category not selected' }); continue; }
    } else if (!prefs.cats.includes(it.category as Cat)) { dropped.push({ name: it.name, reason: 'category not selected' }); continue; }
    if (statusMin) {
      const isRecord = it.evidence_type === 'official_record';
      if ((statusMin[1] === 'all' || isRecord) && STAGE_RANK[it.stage] < STAGE_RANK[statusMin[0] as keyof typeof STAGE_RANK]) { dropped.push({ name: it.name, reason: 'below your status filter' }); continue; }
    }
    // Location
    const coords = ctx.trustCoords ? (it as RawItem & { coords?: Pt }).coords : undefined;
    const point = coords ?? (await ctx.geocode(it.address));
    if (!point) { dropped.push({ name: it.name, reason: 'location could not be confirmed' }); continue; }
    const geom: Geom = { type: 'Point', coordinates: point };
    const m = matchGeom(geom, area);
    if (!m) { dropped.push({ name: it.name, reason: 'outside your area' }); continue; }
    names.add(key);
    const allOfficial = sources.every((s) => ctx.recordUrls.has(s.url));
    const label = it.evidence_type === 'job_posting' ? 'Early signal' : (it.stage === 'filed' && it.evidence_type === 'official_record' && /zoning|planning/i.test(it.status + it.what)) ? 'Proposal' : allOfficial ? 'Primary record' : LABEL[it.evidence_type];
    kept.push({
      changeId: `r${kept.length + 1}`, name: it.name, cat: it.category, type: isEvent ? 'opening_event' : 'announcement', status: it.status, summary: it.what, why: it.why,
      before: it.before ?? undefined, after: it.after ?? undefined, date: it.date_text ? { text: it.date_text, est: !!it.date_is_estimate } : null,
      place: it.address, distanceMi: metersToMiles(m.dist), partly: false, late: false, occurredAt: null, evidenceLabel: label, isEvent, geom,
      conflict: undefined,
      sources: sources.map((s, i) => {
        const v = seen.get(norm(s.url))!;
        const pub = s.published ? Date.parse(s.published) : NaN;
        return { id: `s${kept.length}_${i}`, title: s.title || v.title || v.url, url: v.url, recordId: '', family: it.evidence_type, publishedAt: Number.isFinite(pub) ? pub : NaN, observedAt: ctx.to, publisher: s.publisher || publisherOf(v.url) };
      }),
      _rank: isEvent ? 0 : it.before ? 1 : RANK[it.stage] ?? 3,
    });
  }
  kept.sort((a, b) => a._rank - b._rank || a.distanceMi - b.distanceMi);
  const L = LENS[prefs.len];
  const strip = ({ _rank, ...x }: (typeof kept)[number]) => x;
  const limitations = [...ctx.limitations, ...(raw.report.coverage_notes ?? [])];
  const notLocated = dropped.filter((d) => d.reason === 'location could not be confirmed').length;
  if (notLocated) limitations.push(`${notLocated} item${notLocated === 1 ? ' was' : 's were'} left out because we couldn't place ${notLocated === 1 ? 'it' : 'them'} on the map.`);
  const unverified = dropped.filter((d) => d.reason === 'no source we could verify').length;
  if (unverified) limitations.push(`${unverified} item${unverified === 1 ? ' was' : 's were'} left out because the cited source couldn't be verified.`);
  return {
    summary: raw.report.summary,
    dropped,
    issue: {
      kind: 'sample', areaLabel: areaLabelOf(prefs), periodFrom: ctx.from, periodTo: ctx.to, tz: ctx.tz,
      interests: prefs.cats.map(catName), depth: ctx.depthName ?? depthLabel(prefs), length: L.name, limitations,
      items: kept.slice(0, L.main).map(strip), briefs: kept.slice(L.main, L.main + L.brief).map(strip), fixture: ctx.fixture, coverageOk: 0,
    },
  };
}

export type { RawReport };
