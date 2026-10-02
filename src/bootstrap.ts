/** Assemble the app from configuration. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { App, Clock } from './app.ts';
import { makeLogger } from './app.ts';
import type { Config } from './config.ts';
import { buildRegistry } from './adapters/registry.ts';
import { setFixtureAnchor } from './adapters/fixture.ts';
import { MemoryStore } from './store/memory.ts';
import { PgStore, pgQuery } from './store/postgres.ts';
import type { Store } from './store/types.ts';
import { CensusGeocoder, cached, FixtureGeocoder, MapboxGeocoder } from './providers/geocoder.ts';
import type { Geocoder } from './providers/geocoder.ts';
import { ConsoleMailer, ResendMailer } from './providers/email.ts';
import type { Mailer } from './providers/email.ts';
import { AnthropicResearcher } from './research/anthropic.ts';
import { FixtureResearcher } from './research/fixture.ts';
import type { Researcher } from './research/types.ts';
import { DAY } from './domain/time.ts';

export function fixtureGeocoder(): FixtureGeocoder {
  const f = fileURLToPath(new URL('../data/fixture-geocoder.json', import.meta.url));
  return new FixtureGeocoder(JSON.parse(readFileSync(f, 'utf8')).entries);
}

export async function buildApp(cfg: Config, over: Partial<Pick<App, 'store' | 'geocoder' | 'mailer' | 'researcher' | 'fetch'>> & { quiet?: boolean } = {}): Promise<App & { close: () => Promise<void> }> {
  let close = async () => {};
  let store: Store;
  if (over.store) store = over.store;
  else if (cfg.store === 'postgres') {
    const pg = await pgQuery(cfg.databaseUrl!);
    store = new PgStore(pg.query, cfg.encryptionKey);
    close = pg.end;
  } else store = new MemoryStore();

  const geocoder: Geocoder = over.geocoder ?? cached(cfg.geocoder.provider === 'fixture' ? fixtureGeocoder() : cfg.geocoder.provider === 'mapbox' ? new MapboxGeocoder(cfg.geocoder.mapboxToken!) : new CensusGeocoder());
  const mailer: Mailer = over.mailer ?? (cfg.email.provider === 'resend' && cfg.email.from ? new ResendMailer(cfg.email.apiKey!, cfg.email.from) : new ConsoleMailer());
  let researcher: Researcher | null = over.researcher !== undefined ? over.researcher : null;
  if (over.researcher === undefined) {
    if (cfg.research.provider === 'anthropic') researcher = new AnthropicResearcher({ apiKey: cfg.research.apiKey!, model: cfg.research.model, fetch: over.fetch });
    else if (cfg.research.provider === 'fixture') researcher = new FixtureResearcher(async () => {
      const changes = await store.listChanges();
      return { changes, observations: await store.getObservations(changes.flatMap((c) => c.evidenceIds)) };
    }, cfg.research.fixtureStepMs);
  }

  // Dev clock: fixture mode can move time forward to play out weeks of changes.
  const clock: Clock = { offset: cfg.mode === 'fixture' ? (await store.kvGet<number>('dev:clockOffset')) ?? 0 : 0, now() { return Date.now() + this.offset; } };
  if (cfg.mode === 'fixture') {
    let anchor = await store.kvGet<number>('fixture:anchor');
    if (!anchor) { anchor = Date.now() - 30 * DAY; await store.kvSet('fixture:anchor', anchor); }
    setFixtureAnchor(anchor);
  }
  await store.interruptRunning(clock.now());
  const app: App = { cfg, store, clock, geocoder, mailer, researcher, registry: buildRegistry(cfg), fetch: over.fetch ?? fetch, log: makeLogger(over.quiet) };
  return { ...app, close };
}
