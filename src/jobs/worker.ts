/**
 * Background work: a Postgres-backed job queue (SKIP LOCKED) with bounded retries and dead-lettering,
 * and a scheduler tick that enqueues due work under unique keys.
 */
import type { App } from '../app.ts';
import type { Job } from '../store/types.ts';
import { DAY, localDateKey, MIN, nextSunday } from '../domain/time.ts';
import { newId } from '../lib/crypto.ts';
import { createReminders, refreshAdapter } from '../services/pipeline.ts';
import { dispatchSunday, reconcileDelivery } from '../services/dispatch.ts';

const MAX_ATTEMPTS = 4;
const backoff = (attempt: number) => Math.min(60, 2 ** attempt) * MIN;

type Handler = (app: App, payload: any) => Promise<void>;
export const HANDLERS: Record<string, Handler> = {
  async source_refresh(app, p) {
    const a = app.registry.adapters.find((x) => x.id === p.adapter);
    if (!a) return;
    const r = await refreshAdapter(app, a);
    if (!r.ok) throw new Error(r.error ?? 'refresh failed');
  },
  async reminders(app) { await createReminders(app); },
  async dispatch(app, p) {
    const res = await dispatchSunday(app, p.sunday);
    const failed = res.filter((r) => r.outcome === 'failed' || r.outcome === 'error');
    if (failed.length) throw new Error(`${failed.length} send(s) failed; retrying those issue keys`);
  },
  async retention(app) {
    const n = await app.store.deleteExpiredDrafts(app.clock.now());
    if (n) app.log('retention.drafts_deleted', { count: n });
  },
  async coverage_monitor(app) {
    const runs = await app.store.listAdapterRuns(200);
    const now = app.clock.now();
    for (const a of app.registry.adapters) {
      const last = runs.find((r) => r.adapter === a.id && r.ok);
      if (!last || now - last.at > 2 * DAY) app.log('alert.source_stale', { adapter: a.id, lastOk: last?.at ?? null });
    }
  },
};

/** Enqueue anything that has come due. Unique keys make repeated ticks harmless. */
export async function schedulerTick(app: App) {
  const now = app.clock.now();
  const slot = Math.floor(now / (app.cfg.refreshHours * 3600_000));
  for (const a of app.registry.adapters) await app.store.enqueueJob({ id: newId('job'), type: 'source_refresh', key: `refresh:${a.id}:${slot}`, payload: { adapter: a.id }, runAt: now });
  const hour = Math.floor(now / 3600_000);
  await app.store.enqueueJob({ id: newId('job'), type: 'reminders', key: `reminders:${hour}`, payload: {}, runAt: now });
  await app.store.enqueueJob({ id: newId('job'), type: 'retention', key: `retention:${hour}`, payload: {}, runAt: now });
  await app.store.enqueueJob({ id: newId('job'), type: 'coverage_monitor', key: `coverage:${hour}`, payload: {}, runAt: now });
  const last = (await app.store.kvGet<number>('dispatch:scheduled')) ?? now - 1;
  let s = nextSunday(last, app.cfg.tz);
  while (s <= now) {
    await app.store.enqueueJob({ id: newId('job'), type: 'dispatch', key: `dispatch:${localDateKey(s, app.cfg.tz)}`, payload: { sunday: s }, runAt: s });
    await app.store.kvSet('dispatch:scheduled', s);
    s = nextSunday(s, app.cfg.tz);
  }
  if (app.cfg.mode === 'fixture' && (await app.store.kvGet<boolean>('dev:autoDeliver')) !== false) await autoDeliverFixture(app);
}

/** Fixture mode has no real provider, so accepted messages are marked delivered. */
async function autoDeliverFixture(app: App) {
  for (const a of await app.store.listAccounts()) for (const i of await app.store.listIssues(a.id)) {
    if (i.status === 'accepted' && i.providerMessageId) await reconcileDelivery(app, i.providerMessageId, 'delivered');
  }
}

export async function runJobs(app: App, limit = 50): Promise<number> {
  let n = 0;
  for (; n < limit; n++) {
    const j: Job | null = await app.store.claimJob(app.clock.now());
    if (!j) break;
    const h = HANDLERS[j.type];
    try {
      if (!h) throw new Error(`No handler for ${j.type}`);
      await h(app, j.payload);
      await app.store.finishJob(j.id, true, null, null);
    } catch (e) {
      const err = (e as Error).message.slice(0, 300);
      const retry = j.attempts < MAX_ATTEMPTS ? app.clock.now() + backoff(j.attempts) : null;
      await app.store.finishJob(j.id, false, err, retry);
      app.log(retry ? 'job.retry' : 'alert.job_dead', { job: j.type, key: j.key, attempts: j.attempts, error: err });
    }
  }
  return n;
}

export function startWorker(app: App, everyMs = 30_000) {
  let busy = false;
  const loop = async () => {
    if (busy) return;
    busy = true;
    try { await schedulerTick(app); await runJobs(app); } catch (e) { app.log('worker.error', { error: (e as Error).message.slice(0, 200) }); } finally { busy = false; }
  };
  const t = setInterval(loop, everyMs);
  void loop();
  return () => clearInterval(t);
}
