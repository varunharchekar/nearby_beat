import type { Cat, Stage } from '../domain/types.ts';

/** What the researcher is told. Never contains the street address: only an area description and a rounded center. */
export interface ResearchRequest {
  areaName: string;
  city: string;
  center: [number, number];
  radiusMi: number;
  includeNotes: string[];
  excludeNotes: string[];
  cats: Cat[];
  evAll: boolean;
  depth: 'ann' | 'bal' | 'deep';
  depthLabel: string;
  statusMin: string;
  maxItems: number;
  lookbackDays: number;
  today: string;
  maxSearches: number;
  /** Aim for at least this many items. */
  minItems?: number;
  /** Second pass: names already found, so the research looks for different ones. */
  alreadyFound?: string[];
  /** 'articles': news and announcements only; 'all': also official records and government sites. */
  sources: 'articles' | 'all';
  maxFetches: number;
  fetchMaxTokens: number;
  /** Official records already matched to the area (Dallas adapters). */
  records: OfficialRecord[];
}

export interface OfficialRecord { id: string; url: string; title: string; name: string; place: string; status: string; summary: string; date: string; family: string }

export type EvidenceType = 'official_record' | 'business_announcement' | 'news_report' | 'job_posting' | 'other';

/** One item as the model returns it, before validation. */
export interface RawItem {
  name: string;
  category: Cat;
  stage: Stage;
  status: string;
  what: string;
  why?: string;
  address: string;
  event?: boolean;
  date_text?: string | null;
  date_is_estimate?: boolean;
  before?: string | null;
  after?: string | null;
  evidence_type: EvidenceType;
  /** Restaurants and drinks only: restaurant, bar or cafe. */
  venue?: string | null;
  sources: { url: string; title?: string; publisher?: string; published?: string | null }[];
}
export interface RawReport { summary: string; items: RawItem[]; coverage_notes?: string[] }

export interface Progress {
  stage: 'records' | 'searching' | 'checking' | 'placing' | 'writing' | 'done';
  queries: string[];
  fetched: string[];
  note?: string;
}

export interface Usage { searches: number; inputTokens: number; outputTokens: number; costUsd: number }

export interface ResearchResult {
  report: RawReport;
  /** Every URL the researcher actually saw (search results, fetched pages, supplied records). */
  seenUrls: Map<string, { title: string; pageAge?: string | null }>;
  usage: Usage;
}

export interface Researcher {
  name: string;
  run(req: ResearchRequest, onProgress: (p: Progress) => void, signal: AbortSignal): Promise<ResearchResult>;
}
