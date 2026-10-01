/** Shared domain types. Coordinates are GeoJSON order: [longitude, latitude]. */
export type Pt = [number, number];

export type Cat = 'food' | 'shops' | 'fitness' | 'dev' | 'public' | 'events';
export type Stage = 'signal' | 'announced' | 'filed' | 'approved' | 'construction' | 'open' | 'closed';
export type ChangeType =
  | 'opening_event' | 'reminder' | 'opened' | 'timeline' | 'announcement'
  | 'closure' | 'cancellation' | 'construction' | 'status' | 'early';
export type ReviewState = 'approved' | 'needs_review' | 'rejected';
export type EvidenceLabel =
  | 'Primary record' | 'Owner announcement' | 'Attributed report'
  | 'Early signal' | 'Proposal' | 'Conflicting sources';

export interface Shape {
  kind: 'poly' | 'corridor';
  /** Polygon ring (unclosed) or corridor centerline. */
  coords: Pt[];
  /** Corridor half-width in meters. */
  widthM?: number;
  label: string;
}

export type Geom = { type: 'Point'; coordinates: Pt } | { type: 'LineString'; coordinates: Pt[] };

export interface Prefs {
  /** Saved center. Sensitive: never logged, never placed in URLs or subjects. */
  center: Pt;
  addressLabel: string;
  areaName: string;
  radiusMi: number;
  areaMode: 'radius' | 'custom';
  inc: Shape[];
  exc: Shape[];
  cats: Cat[];
  evAll: boolean;
  preset: 'ann' | 'bal' | 'deep';
  fams: Record<string, boolean>;
  len: 'brief' | 'standard' | 'detailed';
  /** '' | 'approved:records' | 'approved:all' | 'construction:all' | 'open:all' */
  statusMin: string;
}

export interface DateInfo { text: string; est: boolean; at?: number | null }

export interface ObservationFacts {
  name: string;
  address?: string;
  suite?: string;
  geom?: Geom | null;
  cat: Cat;
  stage: Stage;
  statusText: string;
  summary: string;
  why?: string;
  openingDate?: DateInfo | null;
  /** Opening-related event (grand or soft opening) with its local date. */
  event?: { at: number; text: string; kind: 'grand' | 'soft' } | null;
  projectId?: string;
  /** Explicit evidence of closure or cancellation. A missing record is never closure. */
  closed?: boolean;
  canceled?: boolean;
}

export interface SourceObservation {
  id: string;
  adapter: string;
  family: string;
  recordId: string;
  url: string;
  title: string;
  publishedAt: number;
  observedAt: number;
  occurredAt?: number | null;
  contentHash: string;
  facts: ObservationFacts;
  sourceStatus: 'ok' | 'unlocated';
}

export interface Entity {
  id: string;
  key: string;
  type: 'business' | 'project' | 'public';
  canonicalName: string;
  aliases: string[];
  address?: string;
  suite?: string;
  geom?: Geom | null;
  externalIds: string[];
}

export interface ChangeEvent {
  id: string;
  entityId: string;
  dedupeKey: string;
  type: ChangeType;
  cat: Cat;
  isEvent: boolean;
  stage: Stage;
  name: string;
  place: string;
  geom: Geom | null;
  status: string;
  summary: string;
  why?: string;
  before?: string;
  after?: string;
  date?: DateInfo | null;
  occurredAt?: number | null;
  publishedAt: number;
  observedAt: number;
  /** Set when the change is approved; weekly eligibility uses this. */
  approvedAt?: number | null;
  family: string;
  evidenceIds: string[];
  evidenceLabel: EvidenceLabel;
  conflict?: string[];
  review: ReviewState;
  reviewReasons: string[];
}

export interface ContentItem { id: string; dist: number; partly: boolean }
export interface IssueContent { main: ContentItem[]; briefs: ContentItem[]; total: number }
