/** Adapter registry and the coverage inventory shown to users and operators. */
import type { Config } from '../config.ts';
import { FAMILIES } from '../domain/prefs.ts';
import type { SourceAdapter } from './types.ts';
import { tabcApplications, tabcLicenses } from './tabc.ts';
import { legistarZoning } from './legistar.ts';
import { rssAdapter } from './rss.ts';
import { fixtureAdapter } from './fixture.ts';

/** Why each family without a working adapter is unavailable (checked October 2026). */
export const UNAVAILABLE_REASONS: Record<string, string> = {
  permits: 'No current open feed. The Dallas Socrata permits dataset stopped in August 2020, the city ArcGIS permit layer ends in 2024, and the DallasNow (Accela) portal has no public API.',
  occupancy: 'No current open feed for Dallas certificates of occupancy.',
  business_reg: 'No suitable open API for Texas business or assumed-name registrations.',
  jobs: 'No licensed job-posting source configured.',
  planning: 'Dallas planning requests are covered through zoning cases; no separate feed.',
  ordinances: 'Adapter not built yet.',
  agendas: 'Adapter not built yet.',
};

/** Families that operators enter by hand from public announcements in the console. */
export const MANUAL_FAMILIES = ['company', 'websites'];

export interface Registry { adapters: SourceAdapter[]; available: Set<string>; reasons: Record<string, string> }

export function buildRegistry(cfg: Config): Registry {
  if (cfg.mode === 'fixture') {
    const fx = fixtureAdapter();
    return { adapters: fx, available: new Set(fx.map((a) => a.family)), reasons: Object.fromEntries(FAMILIES.filter((f) => !fx.some((a) => a.family === f.id)).map((f) => [f.id, 'No fixture data for this source.'])) };
  }
  const adapters: SourceAdapter[] = [tabcApplications(), tabcLicenses(), legistarZoning(), ...cfg.rssFeeds.map(rssAdapter)];
  const available = new Set([...adapters.map((a) => a.family), ...MANUAL_FAMILIES]);
  const reasons: Record<string, string> = {};
  for (const f of FAMILIES) if (!available.has(f.id)) reasons[f.id] = f.id === 'local_reporting' ? 'No licensed news feeds configured (RSS_FEEDS).' : UNAVAILABLE_REASONS[f.id] ?? 'No working adapter.';
  return { adapters, available, reasons };
}
