/** On-demand research reports and the subscription hand-off. */
import type { App } from '../app.ts';
import type { Prefs, Pt } from '../domain/types.ts';
import type { Draft, Report, SubscriptionRequest } from '../store/types.ts';
import { depthName, LENS, prefsKey } from '../domain/prefs.ts';
import { areaOf, matchGeom } from '../domain/geo.ts';
import { DAY, MIN } from '../domain/time.ts';
import { newId, randomToken, sha256, signValue } from '../lib/crypto.ts';
import type { OfficialRecord, Progress, ResearchRequest } from '../research/types.ts';
import { assemble } from '../research/assemble.ts';
import { downFamilies, reportBlockers, UserError } from './onboarding.ts';
import { inCoverage } from './geo.ts';

export const REPORT_REUSE_WINDOW = 6 * 3600_000;
const tierOf = (p: Prefs): 'ann' | 'bal' | 'deep' => p.preset;
const dayStart = (now: number) => now - (now % DAY);

/** Why a report can't start right now, if anything. */
export async function reportLimits(app: App, d: Draft, visitorKey: string): Promise<string | null> {
  if (!app.researcher) return 'Report generation isn’t configured yet (ANTHROPIC_API_KEY is missing).';
  const now = app.clock.now();
  const r = app.cfg.research;
  if ((await app.store.countReports({ draftId: d.id, since: d.createdAt })) >= r.perDraft) return `You’ve run ${r.perDraft} reports for this search. Your settings are saved; start a new search tomorrow.`;
  if ((await app.store.countReports({ visitorKey, since: dayStart(now) })) >= r.perVisitorPerDay) return `You’ve reached today’s limit of ${r.perVisitorPerDay} reports. Try again tomorrow.`;
  if ((await app.store.countReports({ since: dayStart(now) })) >= r.dailyCap) return 'We’ve hit today’s capacity for new reports. Please try again tomorrow.';
  return null;
}

export async function startReport(app: App, d: Draft, visitorKey: string, opts: { sync?: boolean } = {}): Promise<Report> {
  const blockers = reportBlockers(app, d);
  if (blockers.length) throw new UserError(blockers[0]);
  const prefs = d.prefs!;
  const key = prefsKey(prefs);
  const now = app.clock.now();
  const reuse = await app.store.findReadyReport(d.id, key, now - REPORT_REUSE_WINDOW);
  if (reuse) { d.currentReportId = reuse.id; await app.store.saveDraft(d); return reuse; }
  const limit = await reportLimits(app, d, visitorKey);
  if (limit) throw new UserError(limit);
  const rep: Report = {
    id: newId('rpt'), draftId: d.id, visitorKey, version: d.runs + 1, prefsKey: key, prefs: structuredClone(prefs), status: 'running', error: null,
    progress: { stage: 'records', queries: [], fetched: [] }, summary: null, issue: null, dropped: [], usage: null, researcher: app.researcher!.name,
    createdAt: now, finishedAt: null, expiresAt: d.expiresAt,
  };
  d.runs++;
  d.currentReportId = rep.id;
  await app.store.saveReport(rep);
  await app.store.saveDraft(d);
  const job = runReport(app, rep.id).catch((e) => app.log('report.crash', { report: rep.id, error: (e as Error).message.slice(0, 200) }));
  if (opts.sync) await job;
  return (await app.store.getReport(rep.id)) ?? rep;
}

/** Official records (Dallas adapters) inside the area during the lookback window. */
async function recordsFor(app: App, prefs: Prefs, since: number): Promise<OfficialRecord[]> {
  const area = areaOf(prefs);
  const changes = (await app.store.listChanges({ since })).filter((c) => c.review !== 'rejected' && c.geom && matchGeom(c.geom, area));
  const obs = new Map((await app.store.getObservations(changes.flatMap((c) => c.evidenceIds))).map((o) => [o.id, o]));
  const out: OfficialRecord[] = [];
  for (const c of changes.sort((a, b) => b.observedAt - a.observedAt)) {
    const o = obs.get(c.evidenceIds[0]);
    if (!o || !['permits', 'occupancy', 'alcohol', 'zoning', 'planning', 'ordinances', 'agendas', 'business_reg'].includes(o.family)) continue;
    out.push({ id: c.id, url: o.url, title: o.title, name: c.name, place: c.place, status: c.status, summary: c.summary, date: new Date(o.publishedAt).toISOString().slice(0, 10), family: o.family });
    if (out.length >= 40) break;
  }
  return out;
}

async function geocodeNear(app: App, address: string, center: Pt): Promise<Pt | null> {
  try {
    const r = await app.geocoder.search(address, { types: ['address', 'intersection'], proximity: center, limit: 1 });
    const hit = r.find((x) => x.kind === 'address' || x.kind === 'intersection');
    return hit ? hit.point : null;
  } catch { return null; }
}

export async function runReport(app: App, id: string): Promise<void> {
  const rep = (await app.store.getReport(id))!;
  const save = async (patch: Partial<Report>) => { Object.assign(rep, patch); await app.store.saveReport(rep); };
  const prefs = rep.prefs;
  const now = app.clock.now();
  const from = now - app.cfg.research.lookbackDays * DAY;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), app.cfg.research.timeoutMs);
  let lastSave = 0;
  try {
    const articles = app.cfg.research.sources === 'articles';
    const records = articles ? [] : await recordsFor(app, prefs, from);
    const tier = tierOf(prefs);
    const city = prefs.addressLabel.split(',').slice(1).join(',').replace(/\b\d{5}(-\d{4})?\b/, '').trim() || prefs.areaName;
    const req: ResearchRequest = {
      areaName: prefs.areaName === 'your address' ? city : prefs.areaName, city, center: prefs.center, radiusMi: prefs.radiusMi,
      includeNotes: prefs.areaMode === 'custom' ? prefs.inc.map((s) => s.label) : [], excludeNotes: prefs.areaMode === 'custom' ? prefs.exc.map((s) => s.label) : [],
      cats: prefs.cats, evAll: prefs.evAll, depth: tier, depthLabel: depthName(prefs, app.cfg.research.sources), statusMin: prefs.statusMin,
      sources: app.cfg.research.sources, maxFetches: app.cfg.research.maxFetches, fetchMaxTokens: app.cfg.research.fetchMaxTokens,
      maxItems: LENS[prefs.len].main + LENS[prefs.len].brief, lookbackDays: app.cfg.research.lookbackDays, today: new Date(now).toISOString().slice(0, 10),
      maxSearches: app.cfg.research.maxSearches[tier], records,
    };
    await save({ progress: { stage: 'searching', queries: [], fetched: [], note: records.length ? `${records.length} official records found in your area` : undefined } });
    const onProgress = (p: Progress) => {
      rep.progress = { ...p, note: rep.progress.note };
      const t = Date.now();
      if (t - lastSave > 700) { lastSave = t; void app.store.saveReport(rep); }
    };
    const raw = await app.researcher!.run(req, onProgress, ctrl.signal);
    await save({ progress: { ...rep.progress, stage: 'placing' } });
    const down = await downFamilies(app);
    const limitations: string[] = [];
    if (articles) limitations.push('This report is based on recent news articles and business announcements. It does not check permit, zoning or other government records, so early-stage projects may be missing.');
    else if (!records.length && tier !== 'ann') limitations.push('No official permit or license feed covers this area yet, so findings come from web sources.');
    for (const f of down) limitations.push(`The ${f.replace('_', ' ')} feed failed to refresh, so some official records may be missing.`);
    if (!articles && prefs.cats.includes('fitness')) limitations.push('Fitness and wellness businesses rarely appear in public records, so they depend on announcements and reporting.');
    const out = await assemble(raw, prefs, {
      geocode: (a) => geocodeNear(app, a, prefs.center), from, to: now, tz: app.cfg.tz, fixture: app.cfg.mode === 'fixture',
      limitations, recordUrls: new Set(records.map((r) => r.url)), trustCoords: app.researcher!.name === 'fixture', depthName: depthName(prefs, app.cfg.research.sources),
    });
    await save({ status: 'ready', summary: out.summary, issue: out.issue, dropped: out.dropped, usage: raw.usage, finishedAt: app.clock.now(), progress: { ...rep.progress, stage: 'done' } });
    app.log('report.ready', { report: id, items: out.issue.items.length + out.issue.briefs.length, dropped: out.dropped.length, searches: raw.usage.searches, costUsd: Number(raw.usage.costUsd.toFixed(3)) });
  } catch (e) {
    const aborted = ctrl.signal.aborted;
    const msg = aborted ? 'The research took longer than allowed, so nothing was saved.' : /readable report|ran out of room/.test((e as Error).message) ? (e as Error).message : 'The research service had a problem, so nothing was saved.';
    await save({ status: aborted ? 'timeout' : 'failed', error: msg, finishedAt: app.clock.now() });
    app.log('report.failed', { report: id, aborted, error: (e as Error).message.slice(0, 300) });
  } finally { clearTimeout(timer); }
}

/* ---------- subscription hand-off ---------- */
const validEmail = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(e) && e.length <= 254;
export const CONFIRM_TTL = 60 * MIN;

export async function requestSubscription(app: App, d: Draft, reportId: string, o: { email: string; consent: boolean; marketing: boolean }) {
  const email = o.email.trim().toLowerCase();
  const errors: Record<string, string> = {};
  if (!validEmail(email)) errors.email = 'Enter a valid email address, like name@example.com.';
  if (!o.consent) errors.consent = 'Tick the box so we can email you about this subscription.';
  if (Object.keys(errors).length) return { ok: false as const, errors };
  const rep = await app.store.getReport(reportId);
  if (!rep || rep.draftId !== d.id || rep.status !== 'ready') throw new UserError('That report isn’t available anymore. Run it again first.');
  const now = app.clock.now();
  if ((await app.store.countMagicLinks(email, now - 10 * MIN)) >= 3) throw new UserError('Too many confirmation emails were sent. Wait 10 minutes and try again.');
  const req: SubscriptionRequest = { id: newId('sub'), email, reportId: rep.id, prefs: structuredClone(rep.prefs), consentAt: now, marketing: o.marketing, status: 'pending_confirmation', createdAt: now, confirmedAt: null };
  await app.store.saveSubscriptionRequest(req);
  const token = randomToken();
  await app.store.saveMagicLink({ tokenHash: sha256(token), email, purpose: 'subscribe', payload: { requestId: req.id }, expiresAt: now + CONFIRM_TTL, usedAt: null, createdAt: now });
  const url = `${app.cfg.baseUrl}/subscribe/confirm?token=${encodeURIComponent(token)}`;
  await app.mailer.send({
    to: email, tag: 'service', subject: 'Confirm your Nearby subscription request',
    text: `Confirm that you want weekly Nearby updates for the area and filters you chose:\n\n${url}\n\nThe link works once and expires in 60 minutes. If you didn't ask for this, ignore this email.`,
    html: `<p>Confirm that you want weekly Nearby updates for the area and filters you chose.</p><p><a href="${url}">Confirm my request</a></p><p style="color:#56655E;font-size:13px">The link works once and expires in 60 minutes. If you didn't ask for this, ignore this email.</p>`,
  });
  return { ok: true as const, requestId: req.id };
}

export async function confirmSubscription(app: App, token: string): Promise<{ request: SubscriptionRequest; handoffUrl: string | null } | { error: string }> {
  const m = await app.store.consumeMagicLink(sha256(token), app.clock.now());
  if (!m || m.purpose !== 'subscribe') return { error: 'This link has expired or was already used.' };
  const req = await app.store.getSubscriptionRequest(m.payload.requestId);
  if (!req) return { error: 'We couldn’t find that request.' };
  if (req.status === 'pending_confirmation') { req.status = 'confirmed'; req.confirmedAt = app.clock.now(); await app.store.saveSubscriptionRequest(req); }
  await app.store.audit({ at: app.clock.now(), actor: 'visitor', op: 'subscription.confirmed', detail: `${req.id}${req.marketing ? ' + marketing consent' : ''}` });
  const s = app.cfg.subscribe;
  const handoffUrl = s.url && s.handoffSecret ? `${s.url}${s.url.includes('?') ? '&' : '?'}request=${encodeURIComponent(signValue({ r: req.id, exp: Date.now() + DAY }, s.handoffSecret))}` : null;
  return { request: req, handoffUrl };
}

export const coverageOk = (app: App, p: Pt) => inCoverage(app, p);
