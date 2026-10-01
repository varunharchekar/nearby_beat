import type { ObservationFacts, Pt, SourceObservation } from '../domain/types.ts';
import { sha256 } from '../lib/crypto.ts';

export interface AdapterContext {
  now: number;
  since: number;
  fetch: typeof fetch;
  /** Geocode an address inside the coverage area. Null when it can't be placed confidently. */
  geocode: (address: string) => Promise<Pt | null>;
}

export interface SourceAdapter {
  id: string;
  family: string;
  name: string;
  /** Where the data comes from and the terms it is used under. */
  source: string;
  license: string;
  fetch(ctx: AdapterContext): Promise<SourceObservation[]>;
}

export function observation(adapter: SourceAdapter, o: { recordId: string; url: string; title: string; publishedAt: number; observedAt: number; occurredAt?: number | null; hashOf: unknown; facts: ObservationFacts }): SourceObservation {
  const contentHash = sha256(JSON.stringify(o.hashOf));
  return {
    id: `obs_${sha256(`${adapter.id}|${o.recordId}|${contentHash}`).slice(0, 20)}`,
    adapter: adapter.id, family: adapter.family, recordId: o.recordId, url: o.url, title: o.title,
    publishedAt: o.publishedAt, observedAt: o.observedAt, occurredAt: o.occurredAt ?? null, contentHash,
    facts: o.facts, sourceStatus: o.facts.geom ? 'ok' : 'unlocated',
  };
}

/** Socrata floating timestamps have no zone; the data portals publish Central time. */
export const socrataTime = (ms: number) => new Date(ms - 5 * 3600_000).toISOString().slice(0, 19);
export const parseSocrata = (s: string | undefined) => (s ? Date.parse(`${s.slice(0, 19)}-05:00`) : NaN);

export const titleCase = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b(Llc|Inc|Dba)\b/g, (m) => m.toUpperCase());

export function suiteOf(...parts: (string | undefined)[]): string | undefined {
  for (const p of parts) { const m = p?.match(/\b(?:ste|suite|unit|#)\s*\.?\s*([\w-]+)/i); if (m) return m[1].toUpperCase(); }
  return undefined;
}

const STREET = '(?:Avenue|Street|Road|Drive|Lane|Boulevard|Parkway|Freeway|Expressway|Highway|Place|Court|Circle|Trail|Way|Ave|St|Rd|Dr|Ln|Blvd|Pkwy|Fwy|Expy|Hwy|Pl|Ct|Cir|Trl)';
const ADDRESS_RE = new RegExp(`\\b(\\d{2,6}(?:-\\d{1,6})?\\s+(?:[NSEW]\\.?\\s+)?[A-Z][\\w.']*(?:\\s+[A-Z][\\w.']*){0,3}\\s+${STREET})\\b\\.?`);
export const extractAddress = (text: string) => text.match(ADDRESS_RE)?.[1] ?? null;
