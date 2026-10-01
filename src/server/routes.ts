/** Routes: HTML pages, JSON API, webhooks, operator console and fixture dev tools. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { App } from '../app.ts';
import type { Draft } from '../store/types.ts';
import type { Prefs, Pt } from '../domain/types.ts';
import type { PrefOp } from '../domain/prefs.ts';
import { CATS, depthLabel, effectiveFams, FAMILIES, LENS, PRESETS, presetMap, prefsKey, RADII, STATUS_OPTS, unavailableSelected } from '../domain/prefs.ts';
import { DAY, nextSunday } from '../domain/time.ts';
import { sha256, signValue, verifyValue } from '../lib/crypto.ts';
import { signStripe } from '../providers/billing.ts';
import { resendEvent, verifySvix } from '../providers/email.ts';
import { FIXTURE_WEBHOOK_SECRET } from '../bootstrap.ts';
import * as ob from '../services/onboarding.ts';
import * as acc from '../services/accounts.ts';
import { correctChange, locateChange, manualEntry, refreshAll, reviewChange } from '../services/pipeline.ts';
import { reconcileDelivery } from '../services/dispatch.ts';
import { runJobs, schedulerTick } from '../jobs/worker.ts';
import { one, many, redirect, Router, send, sendJson } from './html.ts';
import type { Ctx } from './html.ts';
import * as V from './views.ts';
import { devPage, opsPage } from './opsviews.ts';

const UserError = ob.UserError;
const STATIC = new Map([['styles.css', 'text/css; charset=utf-8'], ['app.js', 'text/javascript; charset=utf-8']]);
const PUBLIC_DIR = fileURLToPath(new URL('../../public/', import.meta.url));

export function buildRouter(app: App): Router {
  const r = new Router();
  const secure = app.cfg.baseUrl.startsWith('https://');
  const sessionId = (c: Ctx) => acc.readSession(app, c.cookies.nb_session);
  const page = (c: Ctx, p: V.Page, status = 200) => send(c, status, V.layout(app, { ...p, signedIn: !!sessionId(c) }));
  const ipKey = (c: Ctx) => sha256(`${app.cfg.sessionSecret}|${c.ip}|${new Date().toISOString().slice(0, 10)}`).slice(0, 24);
  const draftOf = (c: Ctx) => ob.loadDraft(app, c.cookies.nb_draft);
  const setDraftCookie = (c: Ctx, token: string) => c.setCookie('nb_draft', token, 24 * 3600);
  const isApproved = async (d: Draft) => !!(await ob.approvedPreview(app, d));
  const maxOf = async (d: Draft) => V.maxStep(d, await isApproved(d));
  const signPlan = (scope: string, key: string, ops: PrefOp[]) => signValue({ s: scope, k: sha256(key), ops }, app.cfg.sessionSecret);
  const readPlan = (t: string, scope: string, key: string) => { const v = verifyValue<{ s: string; k: string; ops: PrefOp[] }>(t, app.cfg.sessionSecret); return v && v.s === scope && v.k === sha256(key) ? v.ops : null; };

  async function withDraft(c: Ctx, fn: (d: Draft) => Promise<void>) {
    const d = await draftOf(c);
    if (!d) return redirect(c, '/?expired=1');
    if (!d.prefs && !c.url.pathname.startsWith('/start/location') && c.url.pathname !== '/start/waitlist') return redirect(c, '/');
    return fn(d);
  }
  async function withAccount(c: Ctx, fn: (a: NonNullable<Awaited<ReturnType<typeof app.store.getAccount>>>) => Promise<void>) {
    const id = sessionId(c);
    const a = id ? await app.store.getAccount(id) : null;
    if (!a) return redirect(c, '/login');
    return fn(a);
  }
  const operatorOf = (c: Ctx) => verifyValue<{ op: string; iat: number }>(c.cookies.nb_op, app.cfg.sessionSecret);
  async function withOperator(c: Ctx, fn: (op: string) => Promise<void>) {
    const v = operatorOf(c);
    if (!v || Date.now() - v.iat > 12 * 3600_000) return redirect(c, '/ops/login');
    return fn(v.op);
  }
  const devOnly = (c: Ctx) => { if (!app.cfg.devTools) { send(c, 404, 'Not found', 'text/plain'); return false; } return true; };

  /* ---------- static, health, legal, status ---------- */
  r.get('/static/:file', (c) => {
    const type = STATIC.get(c.params.file);
    if (!type) return send(c, 404, 'Not found', 'text/plain');
    c.res.setHeader('Cache-Control', 'public, max-age=300');
    send(c, 200, readFileSync(PUBLIC_DIR + c.params.file, 'utf8'), type);
  });
  r.get('/healthz', (c) => sendJson(c, 200, { ok: true, mode: app.cfg.mode }));
  r.get('/status', (c) => page(c, { title: 'Coverage and status', body: V.statusPage(app), nav: 'status' }));
  r.get('/legal/:doc', (c) => page(c, { title: c.params.doc === 'terms' ? 'Terms' : 'Privacy', body: V.simplePage(c.params.doc === 'terms' ? 'Terms (draft)' : 'Privacy (draft)', c.params.doc === 'terms'
    ? '<p>These terms are a placeholder. Final terms, billing disclosures and the refund policy need operator approval before launch.</p>'
    : '<p>We store your address encrypted and use it only to measure distance to changes. It never appears in links, analytics, logs or newsletter headings. Unconfirmed drafts are deleted after 24 hours. When you delete your account we remove your address, preferences and archive, keeping only billing records the law requires and a record of free issues used. The final retention policy needs approval before launch.</p>') }));

  /* ---------- onboarding ---------- */
  r.get('/', async (c) => {
    const d = await draftOf(c);
    const cont = d?.prefs ? `<div class="note ok flash">You have a draft in progress. <a href="/start">Continue it</a>.</div>` : '';
    const expired = c.url.searchParams.get('expired') ? '<div class="note warn flash">Your draft expired after 24 hours and was deleted. Start again below.</div>' : '';
    page(c, { title: "Find out what's changing nearby", body: expired + cont + V.landing(app, {}), nav: 'flow' });
  });
  r.get('/start', async (c) => {
    const d = await draftOf(c);
    if (!d?.prefs) return redirect(c, '/');
    page(c, { title: 'Your location', body: V.locationDone(app, d, await maxOf(d)), nav: 'flow' });
  });
  r.post('/start', async (c) => {
    const q = one(c.form.q);
    const radius = Number(one(c.form.radius)) || 1;
    let d = await draftOf(c);
    if (!d) { const nd = await ob.createDraft(app); d = nd.draft; setDraftCookie(c, nd.token); }
    try {
      const cands = await ob.searchAddress(app, d, q);
      if (d.prefs) { d.prefs.radiusMi = RADII.includes(radius) ? radius : 1; await app.store.saveDraft(d); }
      await app.store.kvSet(`draft-radius:${d.id}`, RADII.includes(radius) ? radius : 1);
      return redirect(c, cands.length === 1 ? `/start/location?c=${encodeURIComponent(cands[0].id)}` : '/start/location');
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      page(c, { title: "Find out what's changing nearby", body: V.landing(app, { error: e.message, q, radius }), nav: 'flow' }, 422);
    }
  });
  r.get('/start/location', async (c) => withDraft(c, async (d) => {
    if (!d.candidates?.length) return redirect(c, d.prefs ? '/start' : '/');
    const id = c.url.searchParams.get('c');
    const cand = id ? d.candidates.find((x) => x.id === id) : null;
    if (!cand) return page(c, { title: 'Choose your location', body: V.candidatesPage(d.candidates), nav: 'flow' });
    const radius = (await app.store.kvGet<number>(`draft-radius:${d.id}`)) ?? 1;
    if (!cand.covered) return page(c, { title: 'Outside coverage', body: V.waitlistPage(app, cand, {}), nav: 'flow' });
    page(c, { title: 'Confirm your location', body: V.confirmPin(app, cand, radius, null), nav: 'flow' });
  }));
  r.post('/start/location/choose', async (c) => withDraft(c, async () => redirect(c, `/start/location?c=${encodeURIComponent(one(c.form.candidate))}`)));
  r.post('/start/location/confirm', async (c) => withDraft(c, async (d) => {
    const cand = d.candidates?.find((x) => x.id === one(c.form.candidate));
    if (!cand) return redirect(c, '/');
    const lng = Number(one(c.form.lng)), lat = Number(one(c.form.lat));
    const adjusted: Pt | undefined = one(c.form.moved) && Number.isFinite(lng) && Number.isFinite(lat) && one(c.form.lng) ? [lng, lat] : undefined;
    const radius = (await app.store.kvGet<number>(`draft-radius:${d.id}`)) ?? 1;
    try {
      const res = await ob.confirmLocation(app, d, cand.id, adjusted, radius);
      if (!res.covered) return page(c, { title: 'Outside coverage', body: V.waitlistPage(app, cand, {}), nav: 'flow' });
      redirect(c, '/start/interests');
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      page(c, { title: 'Confirm your location', body: V.confirmPin(app, cand, radius, null, e.message), nav: 'flow' }, 422);
    }
  }));
  r.post('/start/waitlist', async (c) => withDraft(c, async (d) => {
    const cand = d.candidates?.find((x) => x.id === one(c.form.candidate));
    if (!cand) return redirect(c, '/');
    try {
      await ob.joinWaitlist(app, one(c.form.email), cand.city, one(c.form.consent) === '1');
      page(c, { title: 'Waitlist', body: V.waitlistPage(app, cand, { done: true }), nav: 'flow' });
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      page(c, { title: 'Waitlist', body: V.waitlistPage(app, cand, { error: e.message }), nav: 'flow' }, 422);
    }
  }));
  r.post('/start/radius', async (c) => withDraft(c, async (d) => {
    const v = Number(one(c.form.radius));
    if (RADII.includes(v)) { d.prefs!.radiusMi = v; await app.store.saveDraft(d); }
    redirect(c, one(c.form.next) ? '/start/interests' : '/start');
  }));

  r.get('/start/interests', async (c) => withDraft(c, async (d) => page(c, { title: 'Interests', body: V.interestsPage(d, await maxOf(d)), nav: 'flow' })));
  r.post('/start/interests', async (c) => withDraft(c, async (d) => {
    const p = d.prefs!;
    if (one(c.form.all)) p.cats = CATS.map((x) => x.id);
    else if (one(c.form.none)) p.cats = [];
    else p.cats = many(c.form.cats).filter((x) => CATS.some((k) => k.id === x)) as Prefs['cats'];
    if (!one(c.form.all) && !one(c.form.none)) p.evAll = one(c.form.evAll) === '1';
    await app.store.saveDraft(d);
    if (one(c.form.next)) {
      if (!p.cats.length) return page(c, { title: 'Interests', body: V.interestsPage(d, await maxOf(d), 'Choose at least one kind of change to continue.'), nav: 'flow' }, 422);
      return redirect(c, '/start/area');
    }
    redirect(c, '/start/interests');
  }));

  const areaView = async (c: Ctx, d: Draft, error?: string, status = 200) => page(c, { title: 'Area', body: V.areaPage(app, d, await maxOf(d), ob.areaCheck(d.prefs!), error), nav: 'flow' }, status);
  r.get('/start/area', async (c) => withDraft(c, async (d) => {
    if (!d.prefs!.cats.length) return redirect(c, '/start/interests');
    await areaView(c, d);
  }));
  r.post('/start/area', async (c) => withDraft(c, async (d) => {
    const f = c.form, p = d.prefs!;
    const mode = one(f.mode) === 'exclude' ? 'exclude' : 'include';
    try {
      switch (one(f.action)) {
        case 'mode': p.areaMode = one(f.mode) === 'custom' ? 'custom' : 'radius'; await app.store.saveDraft(d); break;
        case 'radius': { const v = Number(one(f.radius)); if (RADII.includes(v)) { p.radiusMi = v; await app.store.saveDraft(d); } break; }
        case 'text': await ob.proposeFromText(app, d, one(f.text)); break;
        case 'neighborhood': await ob.proposeNeighborhood(app, d, mode, one(f.name)); break;
        case 'segment': await ob.proposeSegment(app, d, mode, one(f.road), one(f.from), one(f.to), Number(one(f.width)) || 150); break;
        case 'draw': { let coords: Pt[] = []; try { coords = JSON.parse(one(f.coords) || '[]'); } catch { /* invalid */ } await ob.proposeDrawn(app, d, mode, coords); break; }
        case 'proposal': await ob.resolveProposal(app, d, one(f.id), one(f.apply) === '1'); break;
        case 'remove': await ob.removeShape(app, d, one(f.kind) === 'exc' ? 'exc' : 'inc', Number(one(f.index))); break;
        case 'clarify-dismiss': d.clarify = null; await app.store.saveDraft(d); break;
        case 'next': {
          const blockers = ob.previewBlockers(app, d).filter((b) => /proposed|stretch|larger than/.test(b));
          if (blockers.length) return areaView(c, d, blockers[0], 422);
          return redirect(c, '/start/depth');
        }
      }
      redirect(c, '/start/area');
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      await areaView(c, d, e.message, 422);
    }
  }));

  r.get('/start/depth', async (c) => withDraft(c, async (d) => page(c, { title: 'Research depth', body: V.depthPage(app, d, await maxOf(d)), nav: 'flow' })));
  r.post('/start/depth', async (c) => withDraft(c, async (d) => {
    const f = c.form, p = d.prefs!;
    const preset = one(f.preset) as keyof typeof PRESETS;
    const boxes = Object.fromEntries(FAMILIES.map((x) => [x.id, many(f.fams).includes(x.id)]));
    const boxesChanged = one(f.custom) && FAMILIES.some((x) => !!p.fams[x.id] !== boxes[x.id]);
    if (preset in PRESETS && PRESETS[preset].name !== depthLabel(p)) { p.preset = preset; p.fams = presetMap(preset); }
    else if (boxesChanged) p.fams = boxes;
    if (one(f.len) in LENS) p.len = one(f.len) as Prefs['len'];
    d.ack = one(f.ack) === '1';
    await app.store.saveDraft(d);
    if (!one(f.next)) return redirect(c, '/start/depth');
    if (unavailableSelected(p, app.registry.available).length && !d.ack) return page(c, { title: 'Research depth', body: V.depthPage(app, d, await maxOf(d), 'Confirm that you want to continue with the available sources.'), nav: 'flow' }, 422);
    if (!effectiveFams(p, app.registry.available).length) return page(c, { title: 'Research depth', body: V.depthPage(app, d, await maxOf(d), 'Turn on at least one available source.'), nav: 'flow' }, 422);
    try { await ob.startPreview(app, d, ipKey(c)); } catch (e) { if (!(e instanceof UserError)) throw e; await app.store.kvSet(`flash:${d.id}`, e.message); }
    redirect(c, '/start/sample');
  }));

  const sampleView = async (c: Ctx, d: Draft, o: { error?: string; plan?: { diff: any; token: string; message: string | null } | null; text?: string } = {}, status = 200) => {
    const pv = d.currentPreviewId ? await app.store.getPreview(d.currentPreviewId) : null;
    const flash = await app.store.kvGet<string>(`flash:${d.id}`);
    if (flash) await app.store.kvSet(`flash:${d.id}`, null);
    const blockers = pv ? [] : ob.previewBlockers(app, d);
    page(c, { title: 'Your sample', body: V.samplePage(app, d, await maxOf(d), pv, { ...o, error: o.error ?? flash ?? undefined, blockers, approved: d.approvedPreviewId === pv?.id && (await isApproved(d)) }), nav: 'flow', refresh: pv?.status === 'running' ? 2 : undefined }, status);
  };
  r.get('/start/sample', async (c) => withDraft(c, (d) => sampleView(c, d)));
  r.post('/start/sample', async (c) => withDraft(c, async (d) => {
    const f = c.form;
    try {
      switch (one(f.action)) {
        case 'generate': await ob.startPreview(app, d, ipKey(c)); break;
        case 'approve': await ob.approvePreview(app, d, one(f.preview)); return redirect(c, '/start/signup');
        case 'status': { const v = one(f.statusMin); if (STATUS_OPTS.some((s) => s.v === v)) { await ob.applyRefinement(app, d, [{ k: 'statusMin', v }]); await ob.startPreview(app, d, ipKey(c)); } break; }
        case 'quick': {
          const op = one(f.op);
          const ops: PrefOp[] = op === 'r2' ? [{ k: 'radiusMi', v: 2 }] : op === 'allcats' ? [{ k: 'cats', v: CATS.map((x) => x.id) }] : [{ k: 'preset', v: 'deep' }];
          await ob.applyRefinement(app, d, ops);
          if (unavailableSelected(d.prefs!, app.registry.available).length && !d.ack) return redirect(c, '/start/depth');
          await ob.startPreview(app, d, ipKey(c));
          break;
        }
        case 'refine': {
          const text = one(f.text);
          const plan = await ob.planRefinement(app, d.prefs!, text);
          return sampleView(c, d, { text, plan: { diff: plan.diff, token: signPlan(d.id, prefsKey(d.prefs!), plan.ops), message: plan.message } });
        }
        case 'apply': {
          const ops = readPlan(one(f.plan), d.id, prefsKey(d.prefs!));
          if (!ops) throw new UserError('Your settings changed since that proposal. Describe the change again.');
          await ob.applyRefinement(app, d, ops);
          if (unavailableSelected(d.prefs!, app.registry.available).length && !d.ack) return redirect(c, '/start/depth');
          await ob.startPreview(app, d, ipKey(c));
          break;
        }
      }
      redirect(c, '/start/sample');
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      await sampleView(c, (await app.store.getDraft(d.id))!, { error: e.message }, 422);
    }
  }));

  r.get('/start/signup', async (c) => withDraft(c, async (d) => {
    const pv = await ob.approvedPreview(app, d);
    if (!pv) return redirect(c, '/start/sample');
    const { firstIssueAfter } = await import('../domain/time.ts');
    page(c, { title: 'Sign up', body: V.signupPage(app, d, pv, firstIssueAfter(app.clock.now(), app.cfg.tz), {}), nav: 'flow' });
  }));
  r.post('/start/signup', async (c) => withDraft(c, async (d) => {
    const pv = await ob.approvedPreview(app, d);
    if (!pv) return redirect(c, '/start/sample');
    const email = one(c.form.email);
    const { firstIssueAfter } = await import('../domain/time.ts');
    const first = firstIssueAfter(app.clock.now(), app.cfg.tz);
    try {
      const res = await acc.requestSignup(app, d, { email, consent: one(c.form.consent) === '1', marketing: one(c.form.marketing) === '1' });
      if (!res.ok) return page(c, { title: 'Sign up', body: V.signupPage(app, d, pv, first, { errors: res.errors, email }), nav: 'flow' }, 422);
      c.setCookie('nb_signup', signValue({ e: email.trim().toLowerCase(), m: one(c.form.marketing) === '1' }, app.cfg.sessionSecret), 3600);
      page(c, { title: 'Check your email', body: V.checkEmailPage(app, email.trim().toLowerCase(), res.firstIssueAt), nav: 'flow' });
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      page(c, { title: 'Sign up', body: V.signupPage(app, d, pv, first, { error: e.message, email }), nav: 'flow' }, 422);
    }
  }));
  r.post('/start/signup/resend', async (c) => withDraft(c, async (d) => {
    const v = verifyValue<{ e: string; m: boolean }>(c.cookies.nb_signup, app.cfg.sessionSecret);
    if (!v) return redirect(c, '/start/signup');
    const { firstIssueAfter } = await import('../domain/time.ts');
    try {
      const res = await acc.requestSignup(app, d, { email: v.e, consent: true, marketing: v.m });
      page(c, { title: 'Check your email', body: V.checkEmailPage(app, v.e, res.ok ? res.firstIssueAt : firstIssueAfter(app.clock.now(), app.cfg.tz)), nav: 'flow' });
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      page(c, { title: 'Check your email', body: `<div class="note bad" role="alert">${e.message}</div>` + V.checkEmailPage(app, v.e, firstIssueAfter(app.clock.now(), app.cfg.tz)), nav: 'flow' }, 429);
    }
  }));

  /* ---------- auth ---------- */
  // GET shows a button instead of consuming the token, so link scanners can't use up single-use links.
  r.get('/auth/verify', (c) => page(c, { title: 'Confirm', body: V.simplePage('Confirm your email', `<form method="post" action="/auth/verify"><input type="hidden" name="token" value="${(c.url.searchParams.get('token') ?? '').replace(/[^A-Za-z0-9_-]/g, '')}"><button class="btn primary">Continue</button></form>`) }));
  r.post('/auth/verify', async (c) => {
    const res = await acc.verifyLink(app, one(c.form.token));
    if ('error' in res) return page(c, { title: 'Link problem', body: V.simplePage('This link didn’t work', `<p>${res.error}</p><p><a class="btn" href="/login">Request a new link</a> <a class="btn ghost" href="/start">Back to your draft</a></p>`) }, 400);
    if ('operatorEmail' in res) { c.setCookie('nb_op', signValue({ op: res.operatorEmail, iat: Date.now() }, app.cfg.sessionSecret), 12 * 3600); return redirect(c, '/ops'); }
    c.setCookie('nb_session', acc.makeSession(app, res.accountId), 30 * 24 * 3600);
    if (res.created) c.clearCookie('nb_signup');
    redirect(c, `/account${res.created ? '?welcome=1' : ''}`);
  });
  r.get('/login', (c) => page(c, { title: 'Sign in', body: V.loginPage({}), nav: 'account' }));
  r.post('/login', async (c) => {
    try { await acc.requestLogin(app, one(c.form.email)); page(c, { title: 'Sign in', body: V.loginPage({ sent: true }), nav: 'account' }); }
    catch (e) { if (!(e instanceof UserError)) throw e; page(c, { title: 'Sign in', body: V.loginPage({ error: e.message }), nav: 'account' }, 422); }
  });
  r.post('/logout', (c) => { c.clearCookie('nb_session'); redirect(c, '/'); });

  /* ---------- account ---------- */
  const accountView = async (c: Ctx, a: any, o: { flash?: string; error?: string; edit?: any } = {}, status = 200) => {
    const db = await acc.dashboard(app, a);
    let prices = null;
    try { prices = app.billing ? await app.billing.prices() : null; } catch (e) { app.log('billing.prices_error', { error: (e as Error).message.slice(0, 200) }); }
    page(c, { title: 'My account', body: V.accountPage(app, a, db, { prices, ...o, delAsk: c.url.searchParams.get('delete') === '1' }), nav: 'account' }, status);
  };
  r.get('/account', async (c) => withAccount(c, (a) => accountView(c, a, { flash: c.url.searchParams.get('welcome') ? 'Your email is confirmed and your free issues are scheduled.' : c.url.searchParams.get('saved') ? 'Saved.' : undefined })));
  r.post('/account/prefs', async (c) => withAccount(c, async (a) => {
    try {
      if (one(c.form.action) === 'save') {
        const ops = readPlan(one(c.form.plan), a.id, prefsKey(a.prefs));
        if (!ops) throw new UserError('Your settings changed since that proposal. Describe the change again.');
        await acc.savePrefsEdit(app, a, ops);
        return redirect(c, '/account?saved=1');
      }
      const text = one(c.form.text);
      const plan = text.trim() ? await ob.planRefinement(app, a.prefs, text) : { ops: [] as PrefOp[], diff: [], message: null, clarify: null };
      const ops: PrefOp[] = [...plan.ops];
      const rad = Number(one(c.form.radius));
      if (RADII.includes(rad) && rad !== a.prefs.radiusMi && !ops.some((o) => o.k === 'radiusMi')) ops.push({ k: 'radiusMi', v: rad });
      const len = one(c.form.len);
      if (len in LENS && len !== a.prefs.len && !ops.some((o) => o.k === 'len')) ops.push({ k: 'len', v: len as Prefs['len'] });
      const planned = await acc.planPrefsEdit(a, ops);
      if (planned.errors.length) throw new UserError(planned.errors[0]);
      await accountView(c, a, { edit: { diff: planned.diff, token: signPlan(a.id, prefsKey(a.prefs), ops), message: planned.diff.length ? plan.message : plan.message ?? 'Nothing to change.' } });
    } catch (e) {
      if (!(e instanceof UserError)) throw e;
      await accountView(c, a, { error: e.message }, 422);
    }
  }));
  r.post('/account/pause', async (c) => withAccount(c, async (a) => { await acc.setPaused(app, a, one(c.form.paused) === '1'); redirect(c, '/account?saved=1'); }));
  r.post('/account/unsubscribe', async (c) => withAccount(c, async (a) => { await acc.unsubscribe(app, a.id, 'dashboard'); redirect(c, '/account?saved=1'); }));
  r.post('/account/resubscribe', async (c) => withAccount(c, async (a) => {
    try { await acc.resubscribe(app, a, one(c.form.consent) === '1'); redirect(c, '/account?saved=1'); }
    catch (e) { if (!(e instanceof UserError)) throw e; await accountView(c, a, { error: e.message }, 422); }
  }));
  r.post('/account/delete', async (c) => withAccount(c, async (a) => {
    if (one(c.form.confirm) !== '1') return redirect(c, '/account?delete=1');
    await acc.deleteAccount(app, a);
    c.clearCookie('nb_session');
    page(c, { title: 'Account deleted', body: V.simplePage('Your account was deleted', '<p>We removed your address, preferences and archive. We keep billing records the law requires and a record of free issues used.</p>') });
  }));
  r.post('/account/checkout', async (c) => withAccount(c, async (a) => {
    try { redirect(c, await acc.startCheckout(app, a, one(c.form.plan) === 'annual' ? 'annual' : 'monthly')); }
    catch (e) { if (!(e instanceof UserError)) throw e; await accountView(c, a, { error: e.message }, 422); }
  }));
  r.get('/account/checkout-return', async (c) => withAccount(c, async (a) => { await acc.checkoutReturned(app, a, c.url.searchParams.get('plan') ?? 'monthly'); redirect(c, '/account'); }));
  r.post('/account/renewal', async (c) => withAccount(c, async (a) => {
    try { await acc.setRenewal(app, a, one(c.form.renew) === '1'); await accountView(c, a, { flash: 'Sent to the billing provider. The change appears here once the provider confirms it.' }); }
    catch (e) { if (!(e instanceof UserError)) throw e; await accountView(c, a, { error: e.message }, 422); }
  }));
  r.post('/account/portal', async (c) => withAccount(c, async (a) => {
    try { redirect(c, await acc.portalUrl(app, a)); }
    catch (e) { if (!(e instanceof UserError)) throw e; await accountView(c, a, { error: e.message }, 422); }
  }));
  r.get('/account/issues/:id', async (c) => withAccount(c, async (a) => {
    const i = (await app.store.listIssues(a.id)).find((x) => x.id === c.params.id);
    if (!i || !['delivered', 'accepted'].includes(i.status)) return page(c, { title: 'Not found', body: V.simplePage('Issue not found', '<p><a href="/account">Back to your account</a></p>') }, 404);
    page(c, { title: i.subject, body: V.issuePage(app, a, i, c.url.searchParams.get('plain') === '1'), nav: 'account' });
  }));

  /* ---------- one-click unsubscribe and feedback ---------- */
  r.get('/u/:token', (c) => {
    const id = acc.readUnsubscribeToken(app, c.params.token);
    if (!id) return page(c, { title: 'Unsubscribe', body: V.simplePage('This link isn’t valid', '<p>Sign in to manage email from your account.</p>') }, 400);
    page(c, { title: 'Unsubscribe', body: V.simplePage('Stop the weekly newsletter?', `<form method="post" action="/u/${encodeURIComponent(c.params.token)}"><button class="btn primary">Unsubscribe</button></form><p class="hint">This stops emails right away. If you have a paid plan, it keeps renewing until you cancel it in your account.</p>`) });
  });
  r.post('/u/:token', async (c) => {
    const id = acc.readUnsubscribeToken(app, c.params.token);
    if (!id) return send(c, 400, 'Invalid link', 'text/plain');
    const a = await acc.unsubscribe(app, id, one(c.form['List-Unsubscribe']) ? 'one-click header' : 'email link');
    if (one(c.form['List-Unsubscribe'])) return send(c, 200, 'Unsubscribed', 'text/plain');
    const b = a ? await app.store.getBilling(a.id) : null;
    const paid = b?.sub && ['active', 'past_due'].includes(b.sub.status) && !b.sub.cancelAtEnd;
    page(c, { title: 'Unsubscribed', body: V.simplePage('You’re unsubscribed', `<p>We won't send the weekly newsletter anymore.</p>${paid ? '<div class="note warn"><b>Your paid plan is still active.</b> Unsubscribing doesn’t cancel billing. <a href="/account">Cancel renewal in your account</a>.</div>' : ''}`) });
  });
  r.get('/useful/:token', async (c) => {
    const id = acc.readUnsubscribeToken(app, c.params.token);
    if (id) await app.store.audit({ at: app.clock.now(), actor: 'subscriber', op: 'feedback.useful', detail: `${id}: ${c.url.searchParams.get('v') === 'yes' ? 'yes' : 'no'}` });
    page(c, { title: 'Thanks', body: V.simplePage('Thanks for the feedback', '<p>It helps us decide which sources to add.</p>') });
  });

  /* ---------- operator ---------- */
  r.get('/ops/login', (c) => page(c, { title: 'Operator sign in', body: V.loginPage({ operator: true }) }));
  r.post('/ops/login', async (c) => { await acc.requestOperatorLogin(app, one(c.form.email)); page(c, { title: 'Operator sign in', body: V.loginPage({ operator: true, sent: true }) }); });
  r.post('/ops/logout', (c) => { c.clearCookie('nb_op'); redirect(c, '/'); });
  r.get('/ops', async (c) => withOperator(c, async (op) => page(c, { title: 'Operator console', body: await opsPage(app, c.url.searchParams.get('tab') ?? 'review', op, c.url.searchParams.get('ok') ?? undefined), nav: 'ops' })));
  const opAction = (path: string, fn: (c: Ctx, op: string) => Promise<string>) => r.post(path, async (c) => withOperator(c, async (op) => {
    const tab = one(c.form.tab) || (path === '/ops/manual' ? 'manual' : path === '/ops/refresh' ? 'sources' : 'review');
    try { const msg = await fn(c, op); redirect(c, `/ops?tab=${tab}&ok=${encodeURIComponent(msg)}`); }
    catch (e) { page(c, { title: 'Operator console', body: await opsPage(app, tab, op, undefined, (e as Error).message), nav: 'ops' }, 422); }
  }));
  opAction('/ops/review', async (c, op) => { await reviewChange(app, one(c.form.id), one(c.form.decision) === 'approved' ? 'approved' : 'rejected', op); return 'Saved.'; });
  opAction('/ops/correct', async (c, op) => { await correctChange(app, one(c.form.id), { status: one(c.form.status), summary: one(c.form.summary), dateText: one(c.form.dateText), dateEst: one(c.form.dateEst) === '1' }, op); return 'Correction saved.'; });
  opAction('/ops/locate', async (c, op) => { await locateChange(app, one(c.form.id), one(c.form.address), op); return 'Location set. Approve it when ready.'; });
  opAction('/ops/refresh', async () => { const res = await refreshAll(app); return `Refreshed ${Object.keys(res).length} adapters.`; });
  opAction('/ops/manual', async (c, op) => {
    const f = c.form;
    const url = one(f.url);
    if (!/^https?:\/\//.test(url)) throw new Error('Enter the source link (https://…).');
    const stage = (['announced', 'construction', 'open', 'closed'].includes(one(f.stage)) ? one(f.stage) : 'announced') as 'announced' | 'construction' | 'open' | 'closed';
    const saved = await manualEntry(app, op, {
      family: (['company', 'websites', 'local_reporting'].includes(one(f.family)) ? one(f.family) : 'company') as 'company', url, title: one(f.title) || url,
      publishedAt: Date.parse(`${one(f.published)}T12:00:00Z`) || app.clock.now(), address: one(f.address),
      facts: { name: one(f.name), suite: one(f.suite) || undefined, cat: (CATS.some((x) => x.id === one(f.cat)) ? one(f.cat) : 'shops') as 'shops', stage, closed: stage === 'closed', statusText: one(f.statusText), summary: one(f.summary), openingDate: one(f.opening) ? { text: one(f.opening), est: one(f.openingEst) === '1' } : null },
    });
    return saved.length ? `Added ${saved.length} change(s) to review.` : 'No material change from what we already have.';
  });

  /* ---------- fixture dev tools ---------- */
  r.get('/dev', async (c) => { if (devOnly(c)) page(c, { title: 'Dev tools', body: await devPage(app) }); });
  r.post('/dev/clock', async (c) => {
    if (!devOnly(c)) return;
    if (one(c.form.reset)) app.clock.offset = 0;
    else if (one(c.form.next_sunday)) app.clock.offset = nextSunday(app.clock.now(), app.cfg.tz) + 60_000 - Date.now();
    else app.clock.offset += Number(one(c.form.hours)) * 3600_000;
    await app.store.kvSet('dev:clockOffset', app.clock.offset);
    redirect(c, '/dev');
  });
  r.post('/dev/refresh', async (c) => { if (!devOnly(c)) return; await refreshAll(app); redirect(c, '/dev'); });
  r.post('/dev/tick', async (c) => { if (!devOnly(c)) return; await schedulerTick(app); await runJobs(app); redirect(c, '/dev'); });
  r.post('/dev/autodeliver', async (c) => { if (!devOnly(c)) return; await app.store.kvSet('dev:autoDeliver', one(c.form.on) === '1'); redirect(c, '/dev'); });
  r.post('/dev/deliver', async (c) => { if (!devOnly(c)) return; await reconcileDelivery(app, one(c.form.messageId), one(c.form.event) as any); redirect(c, '/dev'); });
  r.post('/dev/operator', (c) => { if (!devOnly(c)) return; c.setCookie('nb_op', signValue({ op: 'fixture operator', iat: Date.now() }, app.cfg.sessionSecret), 12 * 3600); redirect(c, '/ops'); });
  r.post('/dev/billing', async (c) => {
    if (!devOnly(c)) return;
    const accountId = one(c.form.account), kind = one(c.form.kind);
    const now = Math.floor(Date.now() / 1000), start = app.clock.now();
    const prior = await app.store.getBilling(accountId);
    const plan = (await app.store.getAccount(accountId))?.checkoutPlan ?? 'monthly';
    const end = plan === 'annual' ? start + 365 * DAY : start + 31 * DAY;
    const sub = (status: string, extra: any = {}) => ({ id: 'sub_fixture', customer: 'cus_fixture', status, cancel_at_period_end: false, metadata: { account_id: accountId }, current_period_start: Math.floor((prior?.sub?.termStart ?? start) / 1000), current_period_end: Math.floor((prior?.sub?.termEnd ?? end) / 1000), items: { data: [{ price: { id: `price_test_${plan}`, recurring: { interval: plan === 'annual' ? 'year' : 'month' } } }] }, ...extra });
    const seq = ((await app.store.kvGet<number>('dev:evtSeq')) ?? 0) + 1;
    await app.store.kvSet('dev:evtSeq', seq);
    const events: Record<string, any> = {
      activate: { id: `evt_act_${accountId}`, type: 'customer.subscription.created', created: now, data: { object: sub('active') } },
      duplicate: { id: `evt_act_${accountId}`, type: 'customer.subscription.created', created: now, data: { object: sub('active') } },
      invoice_first: { id: `evt_inv_${seq}`, type: 'invoice.paid', created: now, data: { object: { subscription: 'sub_fixture', customer: 'cus_fixture', parent: { subscription_details: { metadata: { account_id: accountId } } } } } },
      cancel: { id: `evt_cancel_${seq}`, type: 'customer.subscription.updated', created: now + seq, data: { object: sub('active', { cancel_at_period_end: true }) } },
      fail: { id: `evt_fail_${seq}`, type: 'invoice.payment_failed', created: now + seq, data: { object: { subscription: 'sub_fixture', customer: 'cus_fixture' } } },
      end: { id: `evt_end_${seq}`, type: 'customer.subscription.deleted', created: now + seq, data: { object: sub('canceled') } },
      badsig: { id: `evt_bad_${seq}`, type: 'customer.subscription.created', created: now, data: { object: sub('active') } },
    };
    const body = JSON.stringify(events[kind] ?? events.activate);
    const res = await acc.handleBillingWebhook(app, body, kind === 'badsig' ? 't=1,v1=bad' : signStripe(body, FIXTURE_WEBHOOK_SECRET, now));
    await app.store.audit({ at: app.clock.now(), actor: 'dev tools', op: 'dev.billing_event', detail: `${kind}: ${res.status} ${res.note}` });
    redirect(c, '/ops?tab=audit');
  });

  /* ---------- webhooks ---------- */
  r.post('/api/webhooks/billing', async (c) => { const res = await acc.handleBillingWebhook(app, c.body, c.req.headers['stripe-signature'] as string | undefined); sendJson(c, res.status, { note: res.note }); });
  r.post('/api/webhooks/email', async (c) => {
    if (!app.cfg.email.webhookSecret) return sendJson(c, 404, { error: 'Email webhooks are not configured.' });
    if (!verifySvix(c.body, c.req.headers as Record<string, string>, app.cfg.email.webhookSecret)) return sendJson(c, 400, { error: 'Invalid signature' });
    const ev = resendEvent(JSON.parse(c.body));
    if (!ev) return sendJson(c, 200, { ignored: true });
    sendJson(c, 200, { effect: await reconcileDelivery(app, ev.messageId, ev.event) });
  });

  /* ---------- JSON API (PRD section 12) ---------- */
  const apiDraft = async (c: Ctx) => {
    const d = await ob.loadDraft(app, c.req.headers['x-draft-token'] as string | undefined);
    if (!d || (c.params.id && d.id !== c.params.id)) { sendJson(c, 404, { error: 'Draft not found or expired.' }); return null; }
    return d;
  };
  const apiTry = async (c: Ctx, fn: () => Promise<void>) => { try { await fn(); } catch (e) { if (e instanceof UserError) sendJson(c, 422, { error: e.message }); else throw e; } };
  const draftJson = (d: Draft) => ({ id: d.id, expiresAt: d.expiresAt, candidates: d.candidates?.map(({ point, ...x }) => x) ?? null, prefs: d.prefs, proposals: d.proposals, clarify: d.clarify, ack: d.ack, gens: d.gens, currentPreviewId: d.currentPreviewId, approvedPreviewId: d.approvedPreviewId });
  r.post('/api/drafts', async (c) => {
    const { draft, token } = await ob.createDraft(app);
    await apiTry(c, async () => {
      if (c.json?.address) await ob.searchAddress(app, draft, String(c.json.address));
      sendJson(c, 201, { token, draft: draftJson(draft) });
    });
  });
  r.post('/api/drafts/:id/resolve-area', async (c) => { const d = await apiDraft(c); if (!d) return; await apiTry(c, async () => {
    if (c.json?.candidateId) { const res = await ob.confirmLocation(app, d, c.json.candidateId, c.json.adjusted, c.json.radiusMi); if (!res.covered) return sendJson(c, 200, { covered: false, coverage: app.cfg.coverage.name }); }
    if (c.json?.text) await ob.proposeFromText(app, d, String(c.json.text));
    if (c.json?.proposalId) await ob.resolveProposal(app, d, c.json.proposalId, !!c.json.apply);
    sendJson(c, 200, { draft: draftJson(d), area: d.prefs ? ob.areaCheck(d.prefs) : null });
  }); });
  r.patch('/api/drafts/:id/preferences', async (c) => { const d = await apiDraft(c); if (!d) return; await apiTry(c, async () => {
    const p = ob.requirePrefs(d);
    const j = c.json ?? {};
    const next: Prefs = { ...p };
    if (Array.isArray(j.cats)) next.cats = j.cats.filter((x: string) => CATS.some((k) => k.id === x));
    if (typeof j.evAll === 'boolean') next.evAll = j.evAll;
    if (RADII.includes(j.radiusMi)) next.radiusMi = j.radiusMi;
    if (j.areaMode === 'radius' || j.areaMode === 'custom') next.areaMode = j.areaMode;
    if (j.preset in PRESETS) { next.preset = j.preset; next.fams = presetMap(j.preset); }
    if (j.fams && typeof j.fams === 'object') next.fams = Object.fromEntries(FAMILIES.map((f) => [f.id, !!j.fams[f.id]]));
    if (j.len in LENS) next.len = j.len;
    if (typeof j.statusMin === 'string' && STATUS_OPTS.some((s) => s.v === j.statusMin)) next.statusMin = j.statusMin;
    if (typeof j.ack === 'boolean') d.ack = j.ack;
    await ob.setPrefs(app, d, next);
    sendJson(c, 200, { draft: draftJson(d), blockers: ob.previewBlockers(app, d) });
  }); });
  r.post('/api/drafts/:id/previews', async (c) => { const d = await apiDraft(c); if (!d) return; await apiTry(c, async () => { const pv = await ob.startPreview(app, d, ipKey(c)); sendJson(c, 202, { id: pv.id, status: pv.status, cached: pv.cached }); }); });
  r.get('/api/previews/:id/status', async (c) => {
    const d = await ob.loadDraft(app, c.req.headers['x-draft-token'] as string | undefined);
    const pv = await app.store.getPreview(c.params.id);
    if (!d || !pv || pv.draftId !== d.id) return sendJson(c, 404, { error: 'Not found' });
    sendJson(c, 200, { id: pv.id, version: pv.version, status: pv.status, error: pv.error, issue: pv.issue, approvedAt: pv.approvedAt });
  });
  r.post('/api/previews/:id/approve', async (c) => {
    const d = await ob.loadDraft(app, c.req.headers['x-draft-token'] as string | undefined);
    if (!d) return sendJson(c, 404, { error: 'Draft not found or expired.' });
    await apiTry(c, async () => { const pv = await ob.approvePreview(app, d, c.params.id); sendJson(c, 200, { approved: pv.id }); });
  });
  r.post('/api/signup', async (c) => {
    const d = await ob.loadDraft(app, c.req.headers['x-draft-token'] as string | undefined);
    if (!d) return sendJson(c, 404, { error: 'Draft not found or expired.' });
    await apiTry(c, async () => { const res = await acc.requestSignup(app, d, { email: String(c.json?.email ?? ''), consent: c.json?.consent === true, marketing: c.json?.marketing === true }); sendJson(c, res.ok ? 202 : 422, res); });
  });
  r.post('/api/auth/verify', async (c) => {
    const res = await acc.verifyLink(app, String(c.json?.token ?? ''));
    if ('error' in res) return sendJson(c, 400, res);
    if ('operatorEmail' in res) return sendJson(c, 400, { error: 'Use the browser to sign in as an operator.' });
    c.setCookie('nb_session', acc.makeSession(app, res.accountId), 30 * 24 * 3600);
    sendJson(c, 200, { accountId: res.accountId, created: res.created });
  });
  const apiAccount = async (c: Ctx) => { const id = sessionId(c); const a = id ? await app.store.getAccount(id) : null; if (!a) sendJson(c, 401, { error: 'Sign in first.' }); return a; };
  r.get('/api/me', async (c) => { const a = await apiAccount(c); if (!a) return; const db = await acc.dashboard(app, a); sendJson(c, 200, { id: a.id, email: a.email, emailState: a.emailState, paused: a.paused, billing: db.state, freeIssuesLeft: db.left, nextIssueAt: db.next, prefs: a.prefs, prefsVersion: a.prefsVersion, subscription: db.sub }); });
  r.patch('/api/me/preferences', async (c) => { const a = await apiAccount(c); if (!a) return; await apiTry(c, async () => {
    const ops = Array.isArray(c.json?.ops) ? (c.json.ops as PrefOp[]) : [];
    if (!c.json?.confirm) { const p = await acc.planPrefsEdit(a, ops); return sendJson(c, 200, { diff: p.diff, errors: p.errors, confirmRequired: true }); }
    const saved = await acc.savePrefsEdit(app, a, ops);
    sendJson(c, 200, { prefsVersion: saved.prefsVersion });
  }); });
  r.get('/api/me/issues', async (c) => { const a = await apiAccount(c); if (!a) return; sendJson(c, 200, (await app.store.listIssues(a.id)).filter((i) => ['delivered', 'accepted'].includes(i.status)).map((i) => ({ id: i.id, sunday: i.sunday, subject: i.subject, kind: i.kind, status: i.status, issue: i.structured }))); });
  r.post('/api/billing/checkout', async (c) => { const a = await apiAccount(c); if (!a) return; await apiTry(c, async () => sendJson(c, 200, { url: await acc.startCheckout(app, a, c.json?.plan === 'annual' ? 'annual' : 'monthly') })); });
  r.post('/api/billing/portal', async (c) => { const a = await apiAccount(c); if (!a) return; await apiTry(c, async () => sendJson(c, 200, { url: await acc.portalUrl(app, a) })); });
  r.post('/api/unsubscribe', async (c) => { const id = acc.readUnsubscribeToken(app, String(c.json?.token ?? '')) ?? sessionId(c); if (!id) return sendJson(c, 400, { error: 'Invalid token' }); await acc.unsubscribe(app, id, 'api'); sendJson(c, 200, { unsubscribed: true }); });
  r.del('/api/me', async (c) => { const a = await apiAccount(c); if (!a) return; await acc.deleteAccount(app, a); c.clearCookie('nb_session'); sendJson(c, 200, { deleted: true }); });

  return r;
}
