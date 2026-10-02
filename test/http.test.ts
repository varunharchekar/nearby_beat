/** Drives the real HTTP server through the report journey with a cookie jar. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.ts';
import { buildApp } from '../src/bootstrap.ts';
import { makeHandler } from '../src/server/server.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { ConsoleMailer } from '../src/providers/email.ts';
import { refreshAll } from '../src/services/pipeline.ts';

async function boot(env: Record<string, string> = {}) {
  const store = new MemoryStore();
  const mailer = new ConsoleMailer();
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  const cfg = { ...loadConfig({ NEARBY_MODE: 'fixture', FIXTURE_STEP_MS: '20', ...env }), baseUrl: `http://127.0.0.1:${port}` };
  const app = await buildApp(cfg, { store, mailer, quiet: true });
  server.on('request', makeHandler(app));
  await refreshAll(app);
  return { app, store, mailer, base: cfg.baseUrl, close: () => new Promise((r) => server.close(r)) };
}

function client(base: string) {
  const jar = new Map<string, string>();
  async function req(method: string, path: string, body?: Record<string, string | string[]> | object, o: { json?: boolean; headers?: Record<string, string>; sameOrigin?: boolean } = {}) {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (o.sameOrigin !== false && method !== 'GET') headers['sec-fetch-site'] = 'same-origin';
    let payload: string | undefined;
    if (body && o.json) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    else if (body) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(body as Record<string, string | string[]>)) for (const x of Array.isArray(v) ? v : [v]) p.append(k, x);
      payload = p.toString();
    }
    const r = await fetch(base + path, { method, headers, body: payload, redirect: 'manual' });
    for (const sc of r.headers.getSetCookie()) { const [kv] = sc.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1); if (/Max-Age=0/.test(sc)) jar.delete(k); else jar.set(k, v); }
    return { status: r.status, location: r.headers.get('location'), text: await r.text(), headers: r.headers };
  }
  return { req, get: (p: string) => req('GET', p), post: (p: string, b?: Record<string, string | string[]>, o?: { sameOrigin?: boolean }) => req('POST', p, b ?? {}, o) };
}
const follow = async (c: ReturnType<typeof client>, r: Awaited<ReturnType<ReturnType<typeof client>['req']>>) => (r.status === 303 ? c.get(r.location!.replace(/^https?:\/\/[^/]+/, '')) : r);
async function waitReport(u: ReturnType<typeof client>) {
  let r = await u.get('/start/report');
  for (let i = 0; i < 100 && /Researching your area/.test(r.text); i++) { await new Promise((x) => setTimeout(x, 30)); r = await u.get('/start/report'); }
  return r;
}

test('HTTP journey: address → filters → research → report → subscribe → confirm', async () => {
  const { store, mailer, base, close } = await boot({ SUBSCRIPTION_HANDOFF_SECRET: 'handoff-secret-123' });
  try {
    const u = client(base);
    let r = await u.get('/');
    assert.match(r.text, /Start my report/);
    assert.match(r.headers.get('content-security-policy')!, /script-src 'self'/);
    assert.equal((await u.post('/start', { q: '100 Sample Street', radius: '1' }, { sameOrigin: false })).status, 403, 'cross-site post blocked');

    r = await follow(u, await u.post('/start', { q: '100 Sample Street', radius: '1' }));
    const cand = r.text.match(/name="candidate" value="([^"]+)"/)![1];
    r = await u.post('/start/location/confirm', { candidate: cand, lng: '', lat: '' });
    assert.equal(r.location, '/start/interests');
    r = await u.post('/start/interests', { next: '1' });
    assert.equal(r.status, 422, 'zero categories blocked');
    r = await u.post('/start/interests', { cats: ['food', 'shops', 'events', 'public', 'dev'], next: '1' });
    assert.equal(r.location, '/start/area');
    r = await u.post('/start/area', { action: 'next' });
    assert.equal(r.location, '/start/depth');
    r = await u.post('/start/depth', { preset: 'bal', len: 'standard', next: '1' });
    if (r.status === 422) r = await u.post('/start/depth', { preset: 'bal', len: 'standard', ack: '1', next: '1' });
    assert.equal(r.location, '/start/report');

    r = await u.get('/start/report');
    assert.match(r.text, /Researching your area/);
    assert.match(r.text, /http-equiv="refresh"/);
    r = await waitReport(u);
    assert.match(r.text, /Most relevant additions \/ updates/);
    assert.match(r.text, /<th>Latest update<\/th>/);
    assert.match(r.text, /class="chip srcchip" href="https:\/\//);
    assert.match(r.text, /Left out \(\d+\)/);
    assert.ok(!r.text.includes('100 Sample Street, Dallas'), 'home address not shown in the report');

    // Another visitor can't see this report.
    const other = client(base);
    const o = await other.get('/start/report');
    assert.equal(o.status, 303);

    // Refine shows a diff before re-running.
    r = await u.post('/start/report', { action: 'refine', text: 'Only food' });
    assert.match(r.text, /Apply and research again/);

    // Subscribe: consent required; confirmation via single-use link.
    const reportId = r.text.match(/name="report" value="([^"]+)"/)![1];
    r = await u.post('/start/report', { action: 'subscribe', report: reportId, email: 'me@example.com' });
    assert.equal(r.status, 422);
    r = await follow(u, await u.post('/start/report', { action: 'subscribe', report: reportId, email: 'me@example.com', consent: '1' }));
    assert.match(r.text, /Check your email for a confirmation link/);
    const link = mailer.outbox[0].text.match(/https?:\/\/\S+/)![0];
    const token = new URL(link).searchParams.get('token')!;
    r = await u.get(`/subscribe/confirm?token=${encodeURIComponent(token)}`);
    assert.match(r.text, /Confirm your request/);
    const req = (await store.listSubscriptionRequests())[0];
    assert.equal(req.status, 'pending_confirmation', 'GET does not consume the link');
    r = await u.post('/subscribe/confirm', { token });
    assert.match(r.text, /We saved your area and filters/);

    // Hand-off API for the subscription service.
    assert.equal((await fetch(`${base}/api/subscription-requests/${req.id}`)).status, 401);
    const h = await fetch(`${base}/api/subscription-requests/${req.id}`, { headers: { authorization: 'Bearer handoff-secret-123' } });
    assert.equal(h.status, 200);
    const body = await h.json();
    assert.equal(body.email, 'me@example.com');
    assert.equal(body.status, 'confirmed');
    const done = await fetch(`${base}/api/subscription-requests/${req.id}/handed-off`, { method: 'POST', headers: { authorization: 'Bearer handoff-secret-123' } });
    assert.equal(done.status, 200);
    assert.equal((await store.getSubscriptionRequest(req.id))!.status, 'handed_off');

    // Operator console: gated; reports and requests visible without addresses or emails.
    r = await u.get('/ops');
    assert.equal(r.location, '/ops/login');
    await u.post('/dev/operator');
    r = await u.get('/ops?tab=reports');
    assert.match(r.text, /estimated research cost/);
    r = await u.get('/ops?tab=requests');
    assert.ok(!r.text.includes('me@example.com') && !r.text.includes('100 Sample Street'));
  } finally { await close(); }
});

test('JSON API: draft token scopes reports', async () => {
  const { base, close } = await boot();
  try {
    const u = client(base);
    let r = await u.req('POST', '/api/drafts', { address: '100 Sample Street' }, { json: true });
    assert.equal(r.status, 201);
    const { token, draft } = JSON.parse(r.text);
    const H = { 'x-draft-token': token };
    r = await u.req('POST', `/api/drafts/${draft.id}/resolve-area`, { candidateId: draft.candidates[0].id }, { json: true, headers: H });
    assert.equal(r.status, 200);
    r = await u.req('PATCH', `/api/drafts/${draft.id}/preferences`, { cats: [] }, { json: true, headers: H });
    assert.match(JSON.parse(r.text).blockers[0], /at least one/);
    await u.req('PATCH', `/api/drafts/${draft.id}/preferences`, { cats: ['food', 'events'], ack: true }, { json: true, headers: H });
    r = await u.req('POST', `/api/drafts/${draft.id}/reports`, {}, { json: true, headers: H });
    assert.equal(r.status, 202);
    const id = JSON.parse(r.text).id;
    for (let i = 0; i < 100; i++) { r = await u.req('GET', `/api/reports/${id}`, undefined, { headers: H }); if (JSON.parse(r.text).status !== 'running') break; await new Promise((x) => setTimeout(x, 30)); }
    const j = JSON.parse(r.text);
    assert.equal(j.status, 'ready');
    assert.ok(j.report.items.length > 0);
    r = await u.req('GET', `/api/reports/${id}`, undefined, { headers: { 'x-draft-token': 'wrong' } });
    assert.equal(r.status, 404);
  } finally { await close(); }
});

test('address lookup errors explain what to do', async () => {
  const { app, close } = await boot();
  after(close);
  const ob = await import('../src/services/onboarding.ts');
  const census = { name: 'census', search: async () => [] };
  const a = { ...app, geocoder: census } as any;
  const { draft } = await ob.createDraft(a);
  await assert.rejects(ob.searchAddress(a, draft, 'Greenville Ave & Ross Ave'), /Intersections need the Mapbox address lookup/);
  await assert.rejects(ob.searchAddress(a, draft, 'Greenville Ave'), /full street address with city and state/);
  const broken = { ...app, geocoder: { name: 'mapbox', search: async () => { throw new Error('Mapbox geocoding failed: 401'); } } } as any;
  await assert.rejects(ob.searchAddress(broken, draft, '100 Main St, Dallas'), /isn’t responding/);
});
