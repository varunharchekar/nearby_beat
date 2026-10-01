/**
 * Operations CLI.
 *   node src/cli.ts migrate          Apply database migrations
 *   node src/cli.ts refresh          Refresh every source adapter now
 *   node src/cli.ts dispatch         Send any Sundays that have come due
 *   node src/cli.ts check-sources    Call each live source once and report what came back (no writes)
 */
import { loadConfig } from './config.ts';
import { buildApp } from './bootstrap.ts';
import { pgQuery } from './store/postgres.ts';
import { migrate } from './store/migrate.ts';
import { refreshAll } from './services/pipeline.ts';
import { runDueSundays } from './services/dispatch.ts';
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
} else if (cmd === 'dispatch') {
  const app = await buildApp(cfg);
  console.log(await runDueSundays(app));
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
} else {
  console.log('Commands: migrate | refresh | dispatch | check-sources');
  process.exit(1);
}
