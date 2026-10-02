/**
 * Operations CLI.
 *   node src/cli.ts migrate          Apply database migrations
 *   node src/cli.ts refresh          Refresh every source adapter now
 *   node src/cli.ts check-sources    Call each live source once and report what came back (no writes)
 */
import { loadConfig } from './config.ts';
import { buildApp } from './bootstrap.ts';
import { pgQuery } from './store/postgres.ts';
import { migrate } from './store/migrate.ts';
import { refreshAll } from './services/pipeline.ts';
import { tabcApplications, tabcLicenses } from './adapters/tabc.ts';
import { legistarZoning } from './adapters/legistar.ts';
import { rssAdapter } from './adapters/rss.ts';
import { DAY } from './domain/time.ts';

const cmd = process.argv[2];
const cfg = loadConfig();

if (cmd === 'migrate') {
  if (!cfg.databaseUrl) throw new Error('Set DATABASE_URL first.');
  const pg = await pgQuery(cfg.databaseUrl);
  console.log('Applied:', (await migrate(pg.query)).join(', ') || 'nothing new');
  await pg.end();
} else if (cmd === 'refresh') {
  const app = await buildApp(cfg);
  console.log(await refreshAll(app));
  await app.close();
} else if (cmd === 'check-sources') {
  const now = Date.now();
  const adapters = [tabcApplications(), tabcLicenses(), legistarZoning(), ...cfg.rssFeeds.map(rssAdapter)];
  for (const a of adapters) {
    try {
      const obs = await a.fetch({ now, since: now - 30 * DAY, fetch, geocode: async () => null });
      console.log(`OK    ${a.id.padEnd(20)} ${String(obs.length).padStart(4)} records in the last 30 days${obs[0] ? `; e.g. "${obs[0].facts.name}" (${obs[0].facts.statusText})` : ''}`);
    } catch (e) {
      console.log(`FAIL  ${a.id.padEnd(20)} ${(e as Error).message}`);
    }
  }
} else if (cmd === 'research-check') {
  // One small live research call to confirm the API key, model and web search work. Costs a few cents.
  if (!cfg.research.apiKey) throw new Error('Set ANTHROPIC_API_KEY first.');
  const { AnthropicResearcher } = await import('./research/anthropic.ts');
  const r = new AnthropicResearcher({ apiKey: cfg.research.apiKey, model: cfg.research.model });
  const started = Date.now();
  const res = await r.run({
    areaName: 'Lower Greenville', city: 'Dallas, TX', center: [-96.77, 32.81], radiusMi: 0.5, includeNotes: [], excludeNotes: [], cats: ['food'], evAll: false,
    depth: 'ann', depthLabel: 'Announcements', statusMin: '', maxItems: 3, lookbackDays: 60, today: new Date().toISOString().slice(0, 10), maxSearches: 3, records: [], sources: cfg.research.sources, maxFetches: 2, fetchMaxTokens: cfg.research.fetchMaxTokens,
  }, (p) => process.stdout.write(`\r${p.stage}: ${p.queries.length} searches   `), new AbortController().signal);
  console.log(`\nOK in ${Math.round((Date.now() - started) / 1000)}s: ${res.report.items.length} items, ${res.usage.searches} searches, ~$${res.usage.costUsd.toFixed(2)}`);
  for (const it of res.report.items) console.log(`- ${it.name} (${it.address}): ${it.status} [${it.sources.map((s) => s.url).join(', ')}]`);
} else {
  console.log('Commands: migrate | refresh | check-sources | research-check');
  process.exit(1);
}
