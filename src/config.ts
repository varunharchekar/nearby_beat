import { keyFromHex } from './lib/crypto.ts';
import { DEFAULT_TZ } from './domain/time.ts';

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
  creditMode: 'delivery' | 'acceptance';
  geocoder: { provider: 'fixture' | 'mapbox' | 'census'; mapboxToken: string | null };
  mapTiles: { url: string; attribution: string } | null;
  email: { provider: 'console' | 'resend'; apiKey: string | null; from: string | null; webhookSecret: string | null };
  billing: { provider: 'none' | 'stripe'; secretKey: string | null; webhookSecret: string | null; priceMonthly: string | null; priceAnnual: string | null };
  coverage: { name: string; bbox: [number, number, number, number] };
  rssFeeds: { name: string; url: string; license: string }[];
  operatorEmails: string[];
  refreshHours: number;
  lookbackDays: number;
  devTools: boolean;
}

const bool = (v: string | undefined, d = false) => (v == null ? d : /^(1|true|yes|on)$/i.test(v));

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const mode = env.NEARBY_MODE === 'live' ? 'live' : 'fixture';
  const port = Number(env.PORT ?? 3000);
  const devKey = '0'.repeat(64);
  const keyHex = env.ADDRESS_ENCRYPTION_KEY ?? (mode === 'fixture' ? devKey : undefined);
  const sessionSecret = env.SESSION_SECRET ?? (mode === 'fixture' ? 'fixture-only-session-secret' : '');
  if (mode === 'live' && sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters in live mode.');
  if (mode === 'live' && keyHex === devKey) throw new Error('Set a real ADDRESS_ENCRYPTION_KEY in live mode.');
  const mapboxToken = env.MAPBOX_TOKEN ?? null;
  return {
    mode, port,
    baseUrl: (env.BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    tz: env.NEARBY_TZ ?? DEFAULT_TZ,
    sessionSecret,
    store: env.DATABASE_URL ? 'postgres' : 'memory',
    databaseUrl: env.DATABASE_URL ?? null,
    encryptionKey: keyFromHex(keyHex),
    reviewMode: (env.REVIEW_MODE ?? (mode === 'fixture' ? 'flagged' : 'all')) === 'flagged' ? 'flagged' : 'all',
    creditMode: env.CREDIT_MODE === 'acceptance' ? 'acceptance' : 'delivery',
    geocoder: { provider: mode === 'fixture' ? 'fixture' : mapboxToken ? 'mapbox' : 'census', mapboxToken },
    mapTiles: mapboxToken
      ? { url: `https://api.mapbox.com/styles/v1/mapbox/light-v11/tiles/256/{z}/{x}/{y}@2x?access_token=${mapboxToken}`, attribution: '© Mapbox © OpenStreetMap' }
      : env.MAP_TILES_URL ? { url: env.MAP_TILES_URL, attribution: env.MAP_TILES_ATTRIBUTION ?? '' } : null,
    email: {
      provider: env.RESEND_API_KEY && mode === 'live' ? 'resend' : 'console',
      apiKey: env.RESEND_API_KEY ?? null, from: env.EMAIL_FROM ?? null, webhookSecret: env.RESEND_WEBHOOK_SECRET ?? null,
    },
    billing: {
      provider: env.STRIPE_SECRET_KEY ? 'stripe' : 'none',
      secretKey: env.STRIPE_SECRET_KEY ?? null, webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? null,
      priceMonthly: env.STRIPE_PRICE_MONTHLY ?? null, priceAnnual: env.STRIPE_PRICE_ANNUAL ?? null,
    },
    coverage: {
      name: env.COVERAGE_NAME ?? 'Dallas pilot area: Uptown, Knox Henderson, Lower Greenville, M Streets and Lakewood',
      bbox: (env.COVERAGE_BBOX?.split(',').map(Number) as [number, number, number, number]) ?? [-96.85, 32.76, -96.69, 32.89],
    },
    rssFeeds: env.RSS_FEEDS ? JSON.parse(env.RSS_FEEDS) : [],
    operatorEmails: (env.OPERATOR_EMAILS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    refreshHours: Number(env.REFRESH_HOURS ?? 6),
    lookbackDays: 30,
    devTools: mode === 'fixture' || bool(env.DEV_TOOLS),
  };
}

export interface Blocker { feature: string; missing: string[]; effect: string }

/** Production operations that stay disabled until their configuration exists. */
export function configBlockers(c: Config): Blocker[] {
  const b: Blocker[] = [];
  if (c.mode === 'fixture') b.push({ feature: 'Live mode', missing: ['NEARBY_MODE=live'], effect: 'Everything runs on fictional fixtures. No real sources, email or payments.' });
  if (c.mode === 'live' && c.email.provider !== 'resend') b.push({ feature: 'Email sending', missing: ['RESEND_API_KEY', 'EMAIL_FROM'], effect: 'Verification links and issues are logged instead of sent.' });
  if (c.mode === 'live' && !c.email.from) b.push({ feature: 'Sender identity', missing: ['EMAIL_FROM (on a domain with SPF, DKIM and DMARC)'], effect: 'Email sending stays off.' });
  if (c.mode === 'live' && !c.email.webhookSecret) b.push({ feature: 'Delivery confirmation', missing: ['RESEND_WEBHOOK_SECRET'], effect: 'Free-issue credits cannot be confirmed by delivery events.' });
  if (c.billing.provider !== 'stripe' || !c.billing.priceMonthly || !c.billing.priceAnnual) b.push({ feature: 'Checkout', missing: ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_MONTHLY', 'STRIPE_PRICE_ANNUAL'].filter((k) => !(k === 'STRIPE_SECRET_KEY' ? c.billing.secretKey : k === 'STRIPE_PRICE_MONTHLY' ? c.billing.priceMonthly : c.billing.priceAnnual)), effect: 'Plans are shown without prices and checkout is disabled.' });
  if (c.billing.provider === 'stripe' && !c.billing.webhookSecret) b.push({ feature: 'Billing webhooks', missing: ['STRIPE_WEBHOOK_SECRET'], effect: 'Paid access cannot be activated.' });
  if (c.mode === 'live' && c.store !== 'postgres') b.push({ feature: 'Persistence', missing: ['DATABASE_URL'], effect: 'Data is kept in memory and lost on restart.' });
  if (c.mode === 'live' && c.geocoder.provider !== 'mapbox') b.push({ feature: 'Geocoder', missing: ['MAPBOX_TOKEN'], effect: 'Falls back to the US Census geocoder: addresses only, no neighborhoods or ambiguity suggestions.' });
  if (!c.mapTiles) b.push({ feature: 'Map tiles', missing: ['MAPBOX_TOKEN or MAP_TILES_URL'], effect: 'Maps show your area outline without a street basemap.' });
  if (c.mode === 'live' && !c.operatorEmails.length) b.push({ feature: 'Operator console', missing: ['OPERATOR_EMAILS'], effect: 'No one can review changes, so nothing is approved for issues.' });
  return b;
}
