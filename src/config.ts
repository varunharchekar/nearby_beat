import { keyFromHex } from './lib/crypto.ts';
import { DEFAULT_TZ } from './domain/time.ts';

export type Tier = 'ann' | 'bal' | 'deep';

export interface Config {
  mode: 'fixture' | 'live';
  port: number;
  baseUrl: string;
  tz: string;
  sessionSecret: string;
  store: 'memory' | 'postgres';
  databaseUrl: string | null;
  encryptionKey: Buffer;
  reviewMode: 'all' | 'flagged';
  geocoder: { provider: 'fixture' | 'mapbox' | 'census'; mapboxToken: string | null };
  email: { provider: 'console' | 'resend'; apiKey: string | null; from: string | null };
  research: {
    provider: 'fixture' | 'anthropic' | 'none';
    /** 'articles': recent news and announcements only (cheapest). 'all': also official records and government sites. */
    sources: 'articles' | 'all';
    /** Page fetches allowed per report, and the size cap per fetched page. */
    maxFetches: number;
    fetchMaxTokens: number;
    apiKey: string | null;
    model: string;
    /** Web searches allowed per report, by research depth. */
    maxSearches: Record<Tier, number>;
    /** Target number of items. If the first pass returns fewer, a second pass searches for more. */
    minItems: number;
    lookbackDays: number;
    timeoutMs: number;
    perVisitorPerDay: number;
    perDraft: number;
    dailyCap: number;
    /** Fixture researcher pacing, so the progress page can be seen. */
    fixtureStepMs: number;
  };
  /** Optional. Null means any US address. Official Dallas records only cover Dallas either way. */
  coverage: { name: string; bbox: [number, number, number, number] } | null;
  subscribe: { url: string | null; handoffSecret: string | null };
  rssFeeds: { name: string; url: string; license: string }[];
  operatorEmails: string[];
  refreshHours: number;
  devTools: boolean;
}

const bool = (v: string | undefined, d = false) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const num = (v: string | undefined, d: number) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const mode = env.NEARBY_MODE === 'live' ? 'live' : 'fixture';
  const port = num(env.PORT, 3000);
  const devKey = '0'.repeat(64);
  const keyHex = env.ADDRESS_ENCRYPTION_KEY || (mode === 'fixture' ? devKey : undefined);
  const sessionSecret = env.SESSION_SECRET || (mode === 'fixture' ? 'fixture-only-session-secret' : '');
  if (mode === 'live' && sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters in live mode.');
  if (mode === 'live' && keyHex === devKey) throw new Error('Set a real ADDRESS_ENCRYPTION_KEY in live mode.');
  const mapboxToken = env.MAPBOX_TOKEN || null;
  // Trim stray spaces and quotes from copy-pasted keys.
  const apiKey = (env.ANTHROPIC_API_KEY ?? '').trim().replace(/^['"]|['"]$/g, '') || null;
  const bbox = env.COVERAGE_BBOX ? (env.COVERAGE_BBOX.split(',').map(Number) as [number, number, number, number]) : null;
  return {
    mode, port,
    baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    tz: env.NEARBY_TZ || DEFAULT_TZ,
    sessionSecret,
    store: env.DATABASE_URL ? 'postgres' : 'memory',
    databaseUrl: env.DATABASE_URL || null,
    encryptionKey: keyFromHex(keyHex),
    reviewMode: (env.REVIEW_MODE || 'flagged') === 'all' ? 'all' : 'flagged',
    geocoder: { provider: mode === 'fixture' ? 'fixture' : mapboxToken ? 'mapbox' : 'census', mapboxToken },
    email: { provider: env.RESEND_API_KEY && mode === 'live' ? 'resend' : 'console', apiKey: env.RESEND_API_KEY || null, from: env.EMAIL_FROM || null },
    research: {
      provider: mode === 'fixture' ? 'fixture' : apiKey ? 'anthropic' : 'none',
      sources: env.RESEARCH_SOURCES === 'all' ? 'all' : 'articles',
      maxFetches: num(env.FETCHES_PER_REPORT, 5),
      fetchMaxTokens: num(env.FETCH_MAX_TOKENS, 6000),
      apiKey,
      model: env.RESEARCH_MODEL || 'claude-sonnet-5-5',
      maxSearches: { ann: num(env.SEARCHES_ANNOUNCEMENTS, 10), bal: num(env.SEARCHES_BALANCED, 20), deep: num(env.SEARCHES_DEEP, 30) },
      minItems: num(env.MIN_ITEMS, 15),
      lookbackDays: num(env.LOOKBACK_DAYS, 60),
      timeoutMs: num(env.REPORT_TIMEOUT_SECONDS, 480) * 1000,
      perVisitorPerDay: num(env.REPORTS_PER_VISITOR_PER_DAY, 3),
      perDraft: num(env.REPORTS_PER_DRAFT, 3),
      dailyCap: num(env.REPORTS_DAILY_CAP, 100),
      fixtureStepMs: num(env.FIXTURE_STEP_MS, 1500),
    },
    coverage: bbox && bbox.length === 4 && bbox.every(Number.isFinite) ? { name: env.COVERAGE_NAME || 'Supported area', bbox } : null,
    subscribe: { url: env.SUBSCRIBE_URL || null, handoffSecret: env.SUBSCRIPTION_HANDOFF_SECRET || null },
    rssFeeds: env.RSS_FEEDS ? JSON.parse(env.RSS_FEEDS) : [],
    operatorEmails: (env.OPERATOR_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    refreshHours: num(env.REFRESH_HOURS, 6),
    devTools: mode === 'fixture' || bool(env.DEV_TOOLS),
  };
}

export interface Blocker { feature: string; missing: string[]; effect: string }

/** Features that stay off until their configuration exists. */
export function configBlockers(c: Config): Blocker[] {
  const b: Blocker[] = [];
  if (c.mode === 'fixture') b.push({ feature: 'Live mode', missing: ['NEARBY_MODE=live'], effect: 'Reports are built from fictional fixtures by a simulated researcher.' });
  if (c.mode === 'live' && c.research.provider === 'none') b.push({ feature: 'Research', missing: ['ANTHROPIC_API_KEY'], effect: 'Reports cannot be generated.' });
  if (c.mode === 'live' && c.geocoder.provider !== 'mapbox') b.push({ feature: 'Geocoder', missing: ['MAPBOX_TOKEN'], effect: 'US Census geocoder: street addresses only, no intersections, neighborhoods or basemap. Items at intersections may be left out.' });
  if (c.mode === 'live' && c.email.provider !== 'resend') b.push({ feature: 'Email', missing: ['RESEND_API_KEY', 'EMAIL_FROM'], effect: 'Subscription confirmation links appear in Dev tools instead of being emailed.' });
  if (c.mode === 'live' && c.store !== 'postgres') b.push({ feature: 'Persistence', missing: ['DATABASE_URL'], effect: 'Reports and requests are lost on restart.' });
  if (!c.subscribe.url) b.push({ feature: 'Subscription hand-off', missing: ['SUBSCRIBE_URL', 'SUBSCRIPTION_HANDOFF_SECRET'], effect: 'Confirmed subscription requests are stored here until the subscription service exists.' });
  return b;
}
