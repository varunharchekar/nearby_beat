/** Web server + background worker. Usage: node src/main.ts */
import { loadConfig, configBlockers } from './config.ts';
import { buildApp } from './bootstrap.ts';
import { startServer } from './server/server.ts';
import { startWorker } from './jobs/worker.ts';
import { pgQuery } from './store/postgres.ts';
import { migrate } from './store/migrate.ts';
import { refreshAll } from './services/pipeline.ts';

const cfg = loadConfig();
if (cfg.store === 'postgres') {
  const pg = await pgQuery(cfg.databaseUrl!);
  const applied = await migrate(pg.query);
  if (applied.length) console.log(JSON.stringify({ event: 'db.migrated', applied }));
  await pg.end();
}
const app = await buildApp(cfg);
for (const b of configBlockers(cfg)) app.log('config.blocked', { feature: b.feature, missing: b.missing.join(',') });
if (cfg.mode === 'fixture') await refreshAll(app);
const server = startServer(app);
const stop = process.env.NO_WORKER ? () => {} : startWorker(app);
const shutdown = async () => { stop(); server.close(); await app.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
