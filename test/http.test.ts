/** Drives the real HTTP server through the full journey with a cookie jar. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.ts';
import { buildApp, FIXTURE_WEBHOOK_SECRET } from '../src/bootstrap.ts';
import { makeHandler } from '../src/server/server.ts';
import { MemoryStore } from '../src/store/memory.ts';
import { ConsoleMailer } from '../src/providers/email.ts';
import { FakeBilling, signStripe } from '../src/providers/billing.ts';
import { refreshAll } from '../src/services/pipeline.ts';
import { dispatchSunday, reconcileDelivery } from '../src/services/dispatch.ts';
import { nextSunday } from '../src/domain/time.ts';

async function boot() {
  const store = new MemoryStore();
  const mailer = new ConsoleMailer();
  const cfg0 = loadConfig({ NEARBY_MODE: 'fixture', PORT: '0' });
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  const cfg = { ...cfg0, baseUrl: `http://127.0.0.1:${port}` };
  const app = await buildApp(cfg, { store, mailer, billing: new FakeBilling(FIXTURE_WEBHOOK_SECRET), quiet: true });
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
    const text = await r.text();
    return { status: r.status, location: r.headers.get('location'), text, headers: r.headers };
  }
  return { req, jar, get: (p: string) => req('GET', p), post: (p: string, b?: Record<string, string | string[]>, o?: { sameOrigin?: boolean }) => req('POST', p, b ?? {}, o) };
}
const follow = async (c: ReturnType<typeof client>, r: Awaited<ReturnType<ReturnType<typeof client>['req']>>) => (r.status === 303 ? c.get(r.location!.replace(/^https?:\/\/[^/]+/, '')) : r);

test('HTTP journey: sample → refine → signup → issues → account controls', async () => {
  const { app, store, mailer, base, close } = await boot();
  try {
    const u = client(base);
    let r = await u.get('/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy')!, /script-src 'self'/);

    // Cross-site form posts are rejected.
    r = await u.post('/start', { q: '100 Sample Street', radius: '1' }, { sameOrigin: false });
    assert.equal(r.status, 403);

    // Ambiguous address asks; outside coverage offers only a waitlist.
    r = await follow(u, await u.post('/start', { q: 'Main Street', radius: '1' }));
    assert.match(r.text, /Which one did you mean/);
    const outside = r.text.split('<form').find((f) => f.includes('Richardson'))!.match(/name="candidate" value="([^"]+)"/)![1];
    r = await follow(u, await u.post('/start/location/choose', { candidate: outside }));
    assert.match(r.text, /We don&#39;t cover|We don't cover/);
    r = await u.post('/start/waitlist', { candidate: outside, email: 'w@example.com' });
    assert.equal(r.status, 422);
    r = await u.post('/start/waitlist', { candidate: outside, email: 'w@example.com', consent: '1' });
    assert.match(r.text, /on the waitlist/);
    assert.equal(store.waitlist.length, 1);

    r = await follow(u, await u.post('/start', { q: '100 Sample Street', radius: '1' }));
    assert.match(r.text, /Is this the right spot/);
    const cand = r.text.match(/name="candidate" value="([^"]+)"/)![1];
    r = await u.post('/start/location/confirm', { candidate: cand, lng: '', lat: '' });
    assert.equal(r.location, '/start/interests');
    assert.ok(!r.location?.includes('Sample'), 'address never in URLs');

    // Zero categories blocks continuation; selections persist.
    r = await u.post('/start/interests', { next: '1' });
    assert.equal(r.status, 422);
    assert.match(r.text, /Choose at least one kind of change/);
    r = await u.post('/start/interests', { cats: ['food', 'shops', 'events', 'public', 'dev'], next: '1' });
    assert.equal(r.location, '/start/area');
    r = await u.get('/start/interests');
    assert.ok(!/value="fitness" checked/.test(r.text) && /value="food" checked/.test(r.text));

    // Area: custom, text proposals must be confirmed before continuing.
    await u.post('/start/area', { action: 'mode', mode: 'custom' });
    r = await follow(u, await u.post('/start/area', { action: 'text', text: 'exclude everything north of Mockingbird' }));
    assert.match(r.text, /Proposed changes: check the map/);
    r = await u.post('/start/area', { action: 'next' });
    assert.equal(r.status, 422);
    const prop = r.text.match(/name="action" value="proposal"><input type="hidden" name="id" value="([^"]+)"/)![1];
    await u.post('/start/area', { action: 'proposal', id: prop, apply: '1' });
    r = await u.post('/start/area', { action: 'next' });
    assert.equal(r.location, '/start/depth');

    // Depth: unavailable sources need acknowledgement.
    r = await u.post('/start/depth', { preset: 'bal', len: 'standard', next: '1' });
    assert.equal(r.status, 422);
    assert.match(r.text, /Confirm that you want to continue/);
    r = await u.post('/start/depth', { preset: 'bal', len: 'standard', ack: '1', next: '1' });
    assert.equal(r.location, '/start/sample');
    for (let i = 0; i < 20; i++) { r = await u.get('/start/sample'); if (!/Building your sample/.test(r.text)) break; await new Promise((x) => setTimeout(x, 50)); }
    assert.match(r.text, /What changed in your/);
    assert.match(r.text, /Fictional fixtures/);
    assert.ok(!r.text.includes('100 Sample Street, Dallas'), 'home address not in sample heading');

    // Refine: plan shows a diff; apply regenerates; approve the new version.
    r = await u.post('/start/sample', { action: 'refine', text: 'Less detail' });
    assert.match(r.text, /Proposed settings change/);
    const plan = r.text.match(/name="plan" value="([^"]+)"/)![1];
    r = await u.post('/start/sample', { action: 'apply', plan: plan.replace(/&amp;/g, '&') });
    assert.equal(r.location, '/start/sample');
    for (let i = 0; i < 20; i++) { r = await u.get('/start/sample'); if (!/Building your sample/.test(r.text)) break; await new Promise((x) => setTimeout(x, 50)); }
    assert.match(r.text, /sample v2/);
    const pvId = r.text.match(/name="preview" value="([^"]+)"/)![1];
    r = await u.post('/start/sample', { action: 'approve', preview: pvId });
    assert.equal(r.location, '/start/signup');

    // Signup: consent required; link verified with a POST.
    r = await u.post('/start/signup', { email: 'person@example.com' });
    assert.equal(r.status, 422);
    assert.match(r.text, /Tick the box/);
    r = await u.post('/start/signup', { email: 'person@example.com', consent: '1' });
    assert.match(r.text, /Check your email/);
    const link = mailer.outbox[0].text.match(/https?:\/\/\S+/)![0];
    const token = new URL(link).searchParams.get('token')!;
    r = await u.get(`/auth/verify?token=${encodeURIComponent(token)}`);
    assert.match(r.text, /Continue/);
    assert.equal(store.accounts.size, 0, 'GET does not consume the link');
    r = await follow(u, await u.post('/auth/verify', { token }));
    assert.match(r.text, /Your email is confirmed/);
    assert.match(r.text, /3 of 3 left/);
    const acct = [...store.accounts.values()][0];

    // Three Sundays; delivery events count credits; dashboard and archive reflect it.
    let s = acct.firstIssueAt;
    for (let i = 0; i < 3; i++) {
      app.clock.offset = s - Date.now() + 60_000;
      await refreshAll(app);
      await dispatchSunday(app, s);
      for (const iss of await store.listIssues(acct.id)) if (iss.status === 'accepted') await reconcileDelivery(app, iss.providerMessageId!, 'delivered');
      s = nextSunday(s);
    }
    r = await u.get('/account');
    assert.match(r.text, /Trial complete/);
    assert.match(r.text, /0 of 3 left/);
    const issueId = r.text.match(/href="\/account\/issues\/([^"]+)"/)![1];
    r = await u.get(`/account/issues/${issueId}`);
    assert.equal(r.status, 200);
    r = await u.get(`/account/issues/${issueId}?plain=1`);
    assert.match(r.text, /Unsubscribe: /);

    // Another visitor can't read this account's archive.
    const other = client(base);
    r = await other.get(`/account/issues/${issueId}`);
    assert.equal(r.status, 303);
    assert.equal(r.location, '/login');

    // Checkout: redirect alone leaves the plan pending; a signed webhook activates it.
    r = await u.post('/account/checkout', { plan: 'monthly' });
    assert.equal(r.status, 303);
    r = await follow(u, r);
    r = await follow(u, r);
    assert.match(r.text, /Waiting for payment confirmation/);
    const now = Math.floor(Date.now() / 1000), start = app.clock.now();
    const body = JSON.stringify({ id: 'evt_http', type: 'customer.subscription.created', created: now, data: { object: { id: 'sub_h', customer: 'cus_h', status: 'active', cancel_at_period_end: false, metadata: { account_id: acct.id }, current_period_start: Math.floor(start / 1000), current_period_end: Math.floor(start / 1000) + 31 * 86400, items: { data: [{ price: { id: 'price_test_monthly', recurring: { interval: 'month' } } }] } } } });
    r = await u.req('POST', '/api/webhooks/billing', JSON.parse(body), { json: true, headers: { 'stripe-signature': 't=1,v1=bad' }, sameOrigin: false });
    assert.equal(r.status, 400);
    const res = await fetch(`${base}/api/webhooks/billing`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': signStripe(body, FIXTURE_WEBHOOK_SECRET, now) }, body });
    assert.equal(res.status, 200);
    r = await u.get('/account');
    assert.match(r.text, /Paid, active/);

    // One-click unsubscribe from the email link; paid plan warning shown.
    const issue = (await store.listIssues(acct.id))[0];
    const unsub = issue.text.match(/Unsubscribe: (\S+)/)![1].replace(base, '');
    r = await u.get(unsub);
    assert.match(r.text, /Stop the weekly newsletter/);
    r = await client(base).post(unsub, {}, { sameOrigin: false });
    assert.match(r.text, /paid plan is still active/);
    assert.equal(store.accounts.get(acct.id)!.emailState, 'email_unsubscribed');

    // JSON API basics.
    r = await u.req('GET', '/api/me');
    assert.equal(JSON.parse(r.text).billing, 'paid_active');
    r = await other.req('GET', '/api/me');
    assert.equal(r.status, 401);

    // Operator console is gated; dev sign-in works in fixture mode.
    r = await u.get('/ops');
    assert.equal(r.location, '/ops/login');
    await u.post('/dev/operator');
    r = await u.get('/ops?tab=review');
    assert.match(r.text, /Operator console/);
    assert.match(r.text, /Conflicting evidence/);
    r = await u.get('/ops?tab=deliveries');
    assert.ok(!r.text.includes('person@example.com'), 'no subscriber emails in delivery view');

    // Delete account.
    r = await u.post('/account/delete', { confirm: '1' });
    assert.match(r.text, /account was deleted/);
    assert.equal(store.accounts.size, 0);
  } finally { await close(); }
});

test('API draft flow with opaque token', async () => {
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
    r = await u.req('PATCH', `/api/drafts/${draft.id}/preferences`, { cats: ['food', 'events'], ack: true }, { json: true, headers: H });
    r = await u.req('POST', `/api/drafts/${draft.id}/previews`, {}, { json: true, headers: H });
    assert.equal(r.status, 202);
    const pv = JSON.parse(r.text);
    for (let i = 0; i < 20; i++) { r = await u.req('GET', `/api/previews/${pv.id}/status`, undefined, { headers: H }); if (JSON.parse(r.text).status !== 'running') break; await new Promise((x) => setTimeout(x, 50)); }
    assert.equal(JSON.parse(r.text).status, 'ready');
    r = await u.req('GET', `/api/previews/${pv.id}/status`, undefined, { headers: { 'x-draft-token': 'wrong' } });
    assert.equal(r.status, 404, 'other drafts cannot read this preview');
  } finally { await close(); }
});
