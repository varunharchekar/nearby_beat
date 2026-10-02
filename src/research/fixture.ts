/**
 * Simulated researcher for fixture mode and tests. "Searches" the fictional fixture records with realistic pacing,
 * and deliberately returns one uncited item and one far-away item so the validation step is visible.
 */
import type { ChangeEvent, SourceObservation } from '../domain/types.ts';
import { CATS } from '../domain/prefs.ts';
import { geodesic, M_PER_MI } from '../domain/geo.ts';
import type { Progress, RawItem, ResearchRequest, ResearchResult, Researcher } from './types.ts';
import { costOf } from './anthropic.ts';

const EVIDENCE: Record<string, RawItem['evidence_type']> = {
  local_reporting: 'news_report', company: 'business_announcement', websites: 'business_announcement', jobs: 'job_posting',
};

export class FixtureResearcher implements Researcher {
  name = 'fixture';
  private pool: () => Promise<{ changes: ChangeEvent[]; observations: SourceObservation[] }>;
  private stepMs: number;
  constructor(pool: FixtureResearcher['pool'], stepMs = 1500) { this.pool = pool; this.stepMs = stepMs; }

  async run(req: ResearchRequest, onProgress: (p: Progress) => void, signal: AbortSignal): Promise<ResearchResult> {
    const sleep = (ms: number) => new Promise<void>((res, rej) => { const t = setTimeout(res, ms); signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }, { once: true }); });
    const p: Progress = { stage: 'searching', queries: [], fetched: [] };
    const queries = [
      `new restaurants opening ${req.areaName} ${req.city}`, `${req.areaName} coming soon shops`, `${req.areaName} construction development 2026`,
      `${req.city} permits ${req.areaName}`, `${req.areaName} closing`, `${req.areaName} grand opening`,
    ].slice(0, Math.max(2, Math.min(6, Math.round(req.maxSearches / 4))));
    for (const q of queries) { await sleep(this.stepMs); p.queries.push(q); onProgress({ ...p, queries: [...p.queries] }); }
    const { changes, observations } = await this.pool();
    const obs = new Map(observations.map((o) => [o.id, o]));
    const seenUrls: ResearchResult['seenUrls'] = new Map();
    const latest = new Map<string, ChangeEvent>();
    const articleFams = new Set(['local_reporting', 'company', 'websites', 'jobs']);
    for (const c of changes.sort((a, b) => a.observedAt - b.observedAt)) if (c.type !== 'reminder' && (req.sources === 'all' || articleFams.has(c.family))) latest.set(c.entityId, c);
    const items: RawItem[] = [];
    for (const c of latest.values()) {
      const src = c.evidenceIds.map((id) => obs.get(id)).filter(Boolean) as SourceObservation[];
      for (const s of src) seenUrls.set(s.url, { title: s.title });
      const pt = c.geom ? (c.geom.type === 'Point' ? c.geom.coordinates : c.geom.coordinates[Math.floor(c.geom.coordinates.length / 2)]) : null;
      if (pt && geodesic(pt, req.center) > req.radiusMi * M_PER_MI * 2.5) continue;
      items.push({
        name: c.name, category: c.cat, stage: c.stage, status: c.status, what: c.summary, why: c.why, address: c.place, event: c.isEvent,
        date_text: c.date?.text ?? null, date_is_estimate: !!c.date?.est, before: c.before ?? null, after: c.after ?? null,
        evidence_type: EVIDENCE[c.family] ?? 'official_record',
        sources: src.map((s) => ({ url: s.url, title: s.title, published: new Date(s.publishedAt).toISOString().slice(0, 10) })),
        ...(pt ? { coords: pt } : {}),
      } as RawItem);
    }
    p.fetched.push(...items.slice(0, 3).flatMap((i) => i.sources.map((s) => s.url)));
    onProgress({ ...p });
    await sleep(this.stepMs);
    items.push({ name: 'Rumored rooftop bar', category: 'food', stage: 'announced', status: 'Rumored', what: 'A social media post mentions a rooftop bar.', address: 'Greenville Ave, Dallas, TX', evidence_type: 'other', sources: [{ url: 'https://example.com/fixtures/unseen-post' }] });
    items.push({ name: 'Far-away market', category: 'shops', stage: 'announced', status: 'Announced', what: 'A market announced in another part of the city.', address: '500 Example Road, Austin, TX', evidence_type: 'news_report', sources: [{ url: 'https://example.com/fixtures/far-market' }], ...({ coords: [-97.7431, 30.2672] } as object) } as RawItem);
    seenUrls.set('https://example.com/fixtures/far-market', { title: 'Far-away market (fixture)' });
    onProgress({ ...p, stage: 'checking' });
    const u = { searches: p.queries.length, inputTokens: 40_000 + items.length * 3_000, outputTokens: 2_500 + items.length * 150 };
    return {
      report: { summary: `Fixture summary: a mix of new restaurants, a few closures and ongoing street work around ${req.areaName}.`, items, coverage_notes: req.cats.length < CATS.length ? [] : ['Fixture mode: all records are fictional.'] },
      seenUrls, usage: { ...u, costUsd: costOf('claude-sonnet-5-5', u) },
    };
  }
}
