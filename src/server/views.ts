/** Server-rendered pages. Plain HTML forms, so every step works without JavaScript or a mouse. */
import type { App } from '../app.ts';
import type { Account, Draft, GeoCandidate, Issue, Preview } from '../store/types.ts';
import type { Prefs } from '../domain/types.ts';
import { CATS, catName, depthLabel, diffPrefs, effectiveFams, FAMILIES, famName, LENS, PRESETS, RADII, STATUS_OPTS, statusText, unavailableSelected } from '../domain/prefs.ts';
import type { DiffRow } from '../domain/prefs.ts';
import { areaOf, extendsBeyondRadius } from '../domain/geo.ts';
import type { IssueItem, StructuredIssue } from '../domain/issue.ts';
import { areaLabelOf } from '../domain/issue.ts';
import { fmtDate, fmtDateTime, isFifthSunday } from '../domain/time.ts';
import { configBlockers } from '../config.ts';
import { esc } from './html.ts';
import { mapboxStatic, mapSvg } from './map.ts';

export interface Page { title: string; body: string; nav?: 'flow' | 'account' | 'ops' | 'status'; signedIn?: boolean; refresh?: number }

export function layout(app: App, p: Page): string {
  const fixture = app.cfg.mode === 'fixture';
  const navLink = (href: string, key: Page['nav'], t: string) => `<a href="${href}" ${p.nav === key ? 'aria-current="page"' : ''}>${t}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(p.title)} · Nearby</title>${p.refresh ? `<meta http-equiv="refresh" content="${p.refresh}">` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@500;600;700&family=Public+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/static/styles.css"><script src="/static/app.js" defer></script></head><body>
${fixture ? '<div class="ribbon" role="note"><b>Fixture mode</b>Every place, record and story is fictional. No real email is sent and no card is charged.</div>' : ''}
<header class="top"><div class="top-in">
<a class="brand" href="/"><svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="12" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="16" cy="16" r="3.4" fill="currentColor"/><path d="M16 1v7M16 24v7M1 16h7M24 16h7" stroke="currentColor" stroke-width="2.4"/></svg>Nearby</a>
<nav class="nav" aria-label="Main">${navLink('/start', 'flow', 'Get a sample')}${navLink(p.signedIn ? '/account' : '/login', 'account', p.signedIn ? 'My account' : 'Sign in')}</nav>
${app.cfg.devTools ? '<a class="toolbtn" href="/dev">Dev tools</a>' : ''}
</div></header>
<main class="wrap" id="main">${p.body}</main>
<footer class="footer"><a href="/legal/privacy">Privacy</a><a href="/legal/terms">Terms</a><a href="/status">Coverage and status</a></footer>
</body></html>`;
}

const pill = (t: string, tone = '') => `<span class="pill ${tone}">${esc(t)}</span>`;
const note = (t: string, tone = '') => `<div class="note ${tone}">${t}</div>`;
const errBox = (e: string | null | undefined) => (e ? `<div class="note bad flash" role="alert">${esc(e)}</div>` : '');
const basemap = (app: App) => mapboxStatic(app.cfg.geocoder.mapboxToken);

/* ---------------- onboarding ---------------- */
const STEPS = ['Location', 'Interests', 'Area', 'Depth', 'Sample', 'Sign up'];
const STEP_URL = ['/start', '/start/interests', '/start/area', '/start/depth', '/start/sample', '/start/signup'];
function rail(step: number, max: number) {
  return `<nav class="rail" aria-label="Signup steps"><ol>${STEPS.map((s, i) => {
    const k = i + 1;
    const inner = `<span class="n">${k}</span><span class="lbl-t">${s}</span>`;
    return `<li>${k <= max && k !== step ? `<a href="${STEP_URL[i]}" class="${k < step ? 'done' : ''}" style="all:unset;box-sizing:border-box;display:flex;gap:10px;align-items:center;padding:8px 10px;border-radius:6px;cursor:pointer;color:var(--muted)">${inner}</a>` : `<button disabled ${k === step ? 'aria-current="step"' : ''}>${inner}</button>`}</li>`;
  }).join('')}</ol></nav>`;
}
export function maxStep(d: Draft | null, approved: boolean): number {
  if (!d?.prefs) return 1;
  return approved ? 6 : 5;
}
const flow = (step: number, max: number, body: string) => `<div class="flow">${rail(step, max)}<section class="work">${body}</section></div>`;
const head = (step: number, title: string, sub = '') => `<div class="stephead"><span class="eyebrow">Step ${step} of 6</span><h2>${title}</h2>${sub ? `<p class="muted">${sub}</p>` : ''}</div>`;

function radiusField(r: number, auto = false) {
  return `<fieldset class="stack-s" style="border:0;padding:0;margin:0"><legend class="lbl" style="margin-bottom:6px">Radius</legend><div class="row">${RADII.map((x) => `<label class="opt" style="padding:8px 12px"><input type="radio" name="radius" value="${x}" ${r === x ? 'checked' : ''} ${auto ? 'data-autosubmit' : ''}><b>${x} mi</b></label>`).join('')}</div><span class="hint">Straight-line distance from your pin.</span></fieldset>`;
}

export function landing(app: App, o: { error?: string; q?: string; radius?: number }) {
  return `<div class="hero">
  <div class="hero-copy"><span class="eyebrow">Weekly · ${esc(app.cfg.coverage.name.split(':')[0])}</span><h1>Find out what's changing nearby.</h1><p class="lead">A weekly update about openings, development, and neighborhood changes around your address.</p>
   <div class="hero-facts"><div><span class="mono">01</span><span>Enter an address and pick what you care about.</span></div><div><span class="mono">02</span><span>Read a real sample before you sign up.</span></div><div><span class="mono">03</span><span>Your first 3 weekly issues are free. No card required.</span></div></div></div>
  <form class="card stack" method="post" action="/start">
   ${errBox(o.error)}
   <div class="field"><label for="q">Your address or nearest intersection</label><input type="text" id="q" name="q" autocomplete="street-address" required value="${esc(o.q ?? '')}" placeholder="Street address, city or ZIP"><span class="hint">Include the city or ZIP code. Intersections work too, like “Greenville Ave &amp; Ross Ave”.</span></div>
   ${app.cfg.mode === 'fixture' ? '<p class="hint">Fixture addresses: 100 Sample Street · Main Street (ambiguous) · Greenville Ave &amp; Mockingbird · 500 Example Road (outside coverage)</p>' : ''}
   ${radiusField(o.radius ?? 1)}
   <button class="btn primary" type="submit">Create my sample</button>
   <p class="hint">We use your address only to measure distance. It's encrypted, kept with this draft for 24 hours unless you sign up, and never placed in links, analytics or your newsletter heading.</p>
  </form></div>`;
}

export function candidatesPage(cands: GeoCandidate[]) {
  return flow(1, 1, `${head(1, cands.length > 1 ? 'Which one did you mean?' : 'Confirm your location')}
  <div class="stack-s">${cands.map((c) => `<form method="post" action="/start/location/choose"><input type="hidden" name="candidate" value="${esc(c.id)}"><button class="opt" style="width:100%;text-align:left"><span><b>${esc(c.label)}</b><span class="hint">${esc(c.city)}${c.covered ? '' : ' · outside our coverage area'}${c.approx ? ' · approximate' : ''}</span></span></button></form>`).join('')}</div>
  <div><a class="btn" href="/">Search again</a></div>`);
}

export function confirmPin(app: App, c: GeoCandidate, radius: number, adjusted: [number, number] | null, error?: string) {
  const center = adjusted ?? c.point;
  const a = { center, rM: radius * 1609.344, inc: [], exc: [] };
  return flow(1, 1, `${head(1, 'Is this the right spot?', `${esc(c.label)}, ${esc(c.city)}`)}
  <div class="area-layout"><div class="mapwrap">${mapSvg(a, { label: 'Map with a pin at the matched location. Click to move the pin.', interactive: 'pin', basemap: basemap(app) })}<span class="mapcap">Click the map to move the pin</span></div>
  <div class="stack">${errBox(error)}${c.approx ? note('This match is approximate, so the pin sits at the street or intersection. Distances are measured from this point.') : ''}
  ${adjusted ? note('Pin moved. Distances will be measured from the new point.', 'ok') : ''}
  <p id="pin-note" class="hint" aria-live="polite">Moving the pin needs a mouse or touch. Without one, search for an intersection instead.</p>
  <form method="post" action="/start/location/confirm" class="stack-s"><input type="hidden" name="candidate" value="${esc(c.id)}">
   <input type="hidden" name="lng" value="${adjusted ? adjusted[0] : ''}"><input type="hidden" name="lat" value="${adjusted ? adjusted[1] : ''}">
   <button class="btn primary">Yes, use this location</button></form>
  <form method="post" action="/start/location/confirm" id="pin-form" hidden class="stack-s"><input type="hidden" name="candidate" value="${esc(c.id)}"><input type="hidden" name="lng"><input type="hidden" name="lat"><input type="hidden" name="moved" value="1"><button class="btn">Use the new pin</button></form>
  <a class="btn ghost" href="/">Different address</a></div></div>`);
}

export function waitlistPage(app: App, c: GeoCandidate, o: { done?: boolean; error?: string }) {
  return flow(1, 1, `${head(1, `We don't cover ${esc(c.city.split(',')[0])} yet`)}
  ${note(`${esc(app.cfg.coverage.name)}. Join the waitlist and we'll email you once when your area is supported. The waitlist doesn't start a free trial or a newsletter.`)}
  ${o.done ? note(`You're on the waitlist for ${esc(c.city)}.`, 'ok') : `<form class="card stack" method="post" action="/start/waitlist"><input type="hidden" name="candidate" value="${esc(c.id)}">${errBox(o.error)}
   <div class="field"><label for="wl-email">Email</label><input type="email" id="wl-email" name="email" autocomplete="email" required></div>
   <label class="check"><input type="checkbox" name="consent" value="1"><span>Email me once when my area is supported.</span></label>
   <div><button class="btn primary">Join waitlist</button></div></form>`}
  <div><a class="btn" href="/">Try a different address</a></div>`);
}

export function locationDone(app: App, d: Draft, max: number) {
  const p = d.prefs!;
  return flow(1, max, `${head(1, 'Your location')}
  <div class="area-layout"><div class="mapwrap">${mapSvg(areaOf(p), { label: `Your ${p.radiusMi}-mile area`, basemap: basemap(app) })}</div>
  <div class="stack"><div class="panel stack-s"><span class="lbl">Confirmed location</span><p><b>${esc(p.addressLabel)}</b></p><p class="hint">Area name: near ${esc(p.areaName)}. Distances are measured from this pin.</p><div><a class="btn sm" href="/">Change location</a></div></div>
  <form method="post" action="/start/radius" class="stack">${radiusField(p.radiusMi, true)}<div class="stepfoot"><button class="btn sm">Update radius</button><button class="btn primary" name="next" value="1">Continue</button></div></form></div></div>`);
}

export function interestsPage(d: Draft, max: number, error?: string) {
  const p = d.prefs!;
  return flow(2, max, `${head(2, 'What changes would you like to hear about?')}
  <form method="post" action="/start/interests" class="stack">
  ${error ? `<p class="err" role="alert" id="cat-err">${esc(error)}</p>` : ''}
  <div class="row"><button class="btn sm" name="all" value="1">Select all</button><button class="btn sm" name="none" value="1">Clear all</button></div>
  <fieldset class="grid2" style="border:0;padding:0;margin:0" ${error ? 'aria-describedby="cat-err"' : ''}><legend class="sr">Interests</legend>${CATS.map((k) => `<label class="opt"><input type="checkbox" name="cats" value="${k.id}" ${p.cats.includes(k.id) ? 'checked' : ''}><span><b>${esc(k.name)}</b><span class="hint">${esc(k.ex)}</span>${k.id === 'fitness' ? '<span class="hint" style="color:var(--warn)">Limited coverage: these businesses rarely appear in public records.</span>' : ''}</span></label>`).join('')}</fieldset>
  <label class="check"><input type="checkbox" name="evAll" value="1" ${p.evAll ? 'checked' : ''}><span><b>Events across all categories</b><br><span class="hint">Off by default: you get opening events only for the business types you picked. Unrelated recurring events are always left out.</span></span></label>
  <div class="stepfoot"><a class="btn" href="/start">Back</a><button class="btn primary" name="next" value="1">Continue</button></div></form>`);
}

export function areaPage(app: App, d: Draft, max: number, sum: { sqMi: number; over: boolean; limit: number }, error?: string) {
  const p = d.prefs!;
  const custom = p.areaMode === 'custom';
  const a = areaOf(p);
  const shapeLi = (s: Prefs['inc'][number], kind: 'inc' | 'exc', i: number) => `<li><span class="row" style="gap:8px"><span class="sw ${kind}"></span><span>${kind === 'inc' ? 'Include' : 'Exclude'}: ${esc(s.label)}</span></span><form method="post" action="/start/area" class="inline"><input type="hidden" name="action" value="remove"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="index" value="${i}"><button class="btn ghost sm" aria-label="Remove ${esc(s.label)}">Remove</button></form></li>`;
  return flow(3, max, `${head(3, 'Include everything within this radius?')}
  ${errBox(error)}
  <form method="post" action="/start/area" class="row"><input type="hidden" name="action" value="mode">
   <label class="opt"><input type="radio" name="mode" value="radius" ${!custom ? 'checked' : ''} data-autosubmit><b>Yes, use my radius</b></label>
   <label class="opt"><input type="radio" name="mode" value="custom" ${custom ? 'checked' : ''} data-autosubmit><b>Customize my area</b></label><button class="btn sm">Update</button></form>
  <div class="area-layout"><div class="stack-s"><div class="mapwrap">${mapSvg(a, { label: `Map of your area, about ${sum.sqMi.toFixed(1)} square miles`, proposals: d.proposals, interactive: custom ? 'draw' : null, basemap: basemap(app) })}</div>
   ${app.cfg.geocoder.mapboxToken ? '' : '<p class="hint">Street basemap appears once MAPBOX_TOKEN is set. The outline and distances are exact either way.</p>'}
   <div class="row small muted"><span class="row" style="gap:6px"><span class="sw inc"></span>In your area</span><span class="row" style="gap:6px"><span class="sw exc"></span>Excluded</span><span class="row" style="gap:6px"><span class="sw prop"></span>Proposed, not applied</span></div>
   <div class="panel stack-s"><span class="lbl">Area summary</span><p>${p.radiusMi}-mile circle${a.inc.length ? `, ${a.inc.length} added` : ''}${a.exc.length ? `, ${a.exc.length} excluded` : ''}. About <b class="tnum">${sum.sqMi.toFixed(1)} sq mi</b>.</p>
   ${extendsBeyondRadius(a) ? '<p class="hint">Some added shapes reach beyond your radius. Those parts are included.</p>' : ''}
   ${sum.over ? `<p class="err" role="alert">That's larger than the launch limit of ${sum.limit.toFixed(1)} sq mi (a 5-mile circle). Remove or shrink a shape to continue.</p>` : ''}
   <p class="hint">Exclusions always win over the radius and added shapes. Items exactly on a boundary are included.</p></div></div>
  <div class="stack">
   <form method="post" action="/start/area">${radiusField(p.radiusMi, true)}<input type="hidden" name="action" value="radius"><button class="btn sm" style="margin-top:6px">Update radius</button></form>
   ${custom ? `
   ${d.proposals.length ? `<div class="panel stack-s" style="border-color:var(--mark)"><span class="lbl">Proposed changes: check the map, then confirm</span><ul class="shapes">${d.proposals.map((pr) => `<li class="prop"><span>${pr.mode === 'include' ? 'Include' : 'Exclude'}: ${esc(pr.shape.label)}</span><form method="post" action="/start/area" class="btnrow"><input type="hidden" name="action" value="proposal"><input type="hidden" name="id" value="${esc(pr.id)}"><button class="btn sm primary" name="apply" value="1">Apply</button><button class="btn sm" name="apply" value="0">Discard</button></form></li>`).join('')}</ul></div>` : ''}
   ${d.clarify ? `<div class="panel stack-s" style="border-color:var(--mark)"><span class="lbl">Which part of ${esc(d.clarify.road)}?</span><p class="hint">We never treat a street name as its whole length. Enter the cross streets below.</p><form method="post" action="/start/area" class="stack-s"><input type="hidden" name="action" value="segment"><input type="hidden" name="mode" value="${d.clarify.mode}"><input type="hidden" name="road" value="${esc(d.clarify.road)}"><div class="grid2"><div class="field"><label for="cf">From cross street</label><input id="cf" name="from" type="text" required></div><div class="field"><label for="ct">To cross street</label><input id="ct" name="to" type="text" required></div></div><input type="hidden" name="width" value="150"><div class="btnrow"><button class="btn sm primary">Propose this stretch</button></div></form><form method="post" action="/start/area"><input type="hidden" name="action" value="clarify-dismiss"><button class="btn sm ghost">Dismiss</button></form></div>` : ''}
   <form method="post" action="/start/area" class="field"><input type="hidden" name="action" value="text"><label for="geotext">Describe changes (optional)</label><textarea id="geotext" name="text" placeholder="Include Knox Henderson, but exclude everything north of Mockingbird"></textarea><div><button class="btn sm">Propose on map</button></div>${d.geoNote ? `<p class="hint" role="status">${esc(d.geoNote)}</p>` : ''}</form>
   <details class="box"><summary>Neighborhood</summary><div><p class="hint">Neighborhood boundaries are suggestions. The shape you confirm is what we use.</p><form method="post" action="/start/area" class="stack-s"><input type="hidden" name="action" value="neighborhood"><div class="field"><label for="nb">Neighborhood name</label><input id="nb" name="name" type="text" required></div><div class="btnrow"><button class="btn sm" name="mode" value="include">Include</button><button class="btn sm" name="mode" value="exclude">Exclude</button></div></form></div></details>
   <details class="box"><summary>Street segment</summary><div><form method="post" action="/start/area" class="stack-s"><input type="hidden" name="action" value="segment">
    <div class="field"><label for="sr">Street</label><input id="sr" name="road" type="text" required placeholder="Greenville Ave"></div>
    <div class="grid2"><div class="field"><label for="sf">From cross street</label><input id="sf" name="from" type="text" required></div><div class="field"><label for="st">To cross street</label><input id="st" name="to" type="text" required></div></div>
    <div class="field"><label for="sw">Corridor width on each side (meters)</label><input id="sw" name="width" type="number" min="25" max="600" step="25" value="150"></div>
    <div class="btnrow"><button class="btn sm" name="mode" value="include">Include segment</button><button class="btn sm" name="mode" value="exclude">Exclude segment</button></div></form></div></details>
   <details class="box"><summary>Draw a shape</summary><div><p class="hint">Click the map to add corners, then save. Drawing needs a mouse or touch; the other tools work by keyboard.</p>
    <form method="post" action="/start/area" id="draw-form" class="stack-s"><input type="hidden" name="action" value="draw"><input type="hidden" name="coords"><p id="draw-count" class="hint" aria-live="polite">0 corners</p>
    <div class="btnrow"><button type="submit" class="btn sm" name="mode" value="include" disabled>Save as inclusion</button><button type="submit" class="btn sm" name="mode" value="exclude">Save as exclusion</button><button type="button" class="btn sm ghost" id="draw-clear">Clear</button></div></form></div></details>
   ${p.inc.length || p.exc.length ? `<div class="stack-s"><span class="lbl">Applied shapes</span><ul class="shapes">${p.inc.map((s, i) => shapeLi(s, 'inc', i)).join('')}${p.exc.map((s, i) => shapeLi(s, 'exc', i)).join('')}</ul></div>` : ''}
   ` : ''}
   <div class="stepfoot"><a class="btn" href="/start/interests">Back</a><form method="post" action="/start/area"><input type="hidden" name="action" value="next"><button class="btn primary">Continue</button></form></div>
  </div></div>`);
}

export function depthPage(app: App, d: Draft, max: number, error?: string) {
  const p = d.prefs!;
  const lab = depthLabel(p);
  const un = unavailableSelected(p, app.registry.available);
  return flow(4, max, `${head(4, 'How far should we dig?', 'Depth changes which sources we read. It does not promise more stories or more certainty.')}
  ${errBox(error)}
  <form method="post" action="/start/depth" class="stack">
  <fieldset class="grid3" style="border:0;padding:0;margin:0"><legend class="sr">Research depth</legend>${(['ann', 'bal', 'deep'] as const).map((k) => `<label class="opt"><input type="radio" name="preset" value="${k}" ${lab === PRESETS[k].name ? 'checked' : ''}><span><b>${PRESETS[k].name}${k === 'bal' ? ' <span class="pill">Recommended</span>' : ''}</b><span class="hint">${esc(PRESETS[k].desc)}</span></span></label>`).join('')}</fieldset>
  ${lab === 'Custom' ? `<p>${pill('Custom', 'fix')} <span class="hint">You chose individual sources.</span></p>` : ''}
  <details class="box" ${lab === 'Custom' ? 'open' : ''}><summary>Choose individual sources</summary><div><div class="tablewrap"><table class="fams"><thead><tr><th>Source</th><th>Status</th></tr></thead><tbody>
  ${FAMILIES.map((f) => `<tr><td><label class="check"><input type="checkbox" name="fams" value="${f.id}" ${p.fams[f.id] ? 'checked' : ''}><span>${esc(f.name)}</span></label></td><td>${app.registry.available.has(f.id) ? pill('Available', 'ok') : `${pill('Unavailable', 'bad')} <span class="hint">${esc(app.registry.reasons[f.id] ?? '')}</span>`}</td></tr>`).join('')}</tbody></table></div>
  <input type="hidden" name="custom" value="1"><p class="hint">Changing these boxes makes your selection Custom. Choosing a preset above resets them.</p></div></details>
  ${un.length ? `<div class="note warn stack-s"><p><b>Not available yet:</b> ${un.map((f) => esc(famName(f))).join(', ')}. We'll search only the sources that work.</p><label class="check"><input type="checkbox" name="ack" value="1" ${d.ack ? 'checked' : ''}><span>Continue with the available sources</span></label></div>` : ''}
  <div class="note fix small">How we label things: a permit filing is not an approval, an approval is not construction, and a hiring notice is not an opening date.</div>
  <fieldset class="stack-s" style="border:0;padding:0;margin:0"><legend class="lbl" style="margin-bottom:6px">Newsletter length</legend><p class="hint">Separate from depth. Every item keeps its source, even in Brief.</p>
  <div class="row">${Object.entries(LENS).map(([k, v]) => `<label class="opt" style="padding:8px 12px"><input type="radio" name="len" value="${k}" ${p.len === k ? 'checked' : ''}><span><b>${v.name}</b><span class="hint">Up to ${v.main} items${v.brief ? ` + ${v.brief} brief` : ''}</span></span></label>`).join('')}</div></fieldset>
  <div class="stepfoot"><a class="btn" href="/start/area">Back</a><div class="btnrow"><button class="btn" name="save" value="1">Save</button><button class="btn primary" name="next" value="1">Show my sample</button></div></div></form>`);
}

function storyHtml(it: IssueItem, i: number, len: Prefs['len']) {
  const tone = it.evidenceLabel === 'Conflicting sources' ? 'bad' : it.evidenceLabel === 'Early signal' || it.evidenceLabel === 'Proposal' ? 'warn' : it.evidenceLabel === 'Attributed report' ? 'info' : 'ok';
  return `<article class="story"><div class="story-top">${pill(catName(it.cat))}${it.isEvent ? pill('Opening event', 'info') : ''}<span class="stamp" style="color:var(--${tone})">${esc(it.evidenceLabel)}</span>${it.partly ? pill('Partly in your area', 'warn') : ''}${it.late ? pill(`Late record: ${fmtDate(it.occurredAt!)}`, 'warn') : ''}</div>
  <h3><span class="num">${String(i + 1).padStart(2, '0')}</span><span>${esc(it.name)}</span></h3>
  <p class="small muted">${esc(it.place)} · <span class="tnum">≈${it.distanceMi < 0.1 ? '<0.1' : it.distanceMi.toFixed(1)} mi</span> approximate distance</p>
  <dl class="facts"><dt>Status</dt><dd>${esc(it.status)}</dd>${it.before ? `<dt>Changed</dt><dd><span class="muted" style="text-decoration:line-through">${esc(it.before)}</span> → <b>${esc(it.after)}</b></dd>` : ''}<dt>What</dt><dd>${esc(it.summary)}</dd>${len !== 'brief' && it.why ? `<dt>Why</dt><dd>${esc(it.why)}</dd>` : ''}${it.date ? `<dt>Date</dt><dd>${it.date.est ? `<span class="est">${esc(it.date.text)} · estimate</span>` : esc(it.date.text)}</dd>` : ''}${it.conflict && len !== 'brief' ? `<dt>Sources</dt><dd>${it.conflict.map(esc).join('<br>')}</dd>` : ''}</dl>
  ${it.sources.map((s) => `<p class="ev small">Source: <a href="${esc(s.url)}" rel="noopener noreferrer">${esc(s.title)}</a> · published ${fmtDate(s.publishedAt)} · <span class="mono">${esc(s.recordId)}</span></p>`).join('')}</article>`;
}

export function issueBlock(app: App, st: StructuredIssue, prefs: Prefs, o: { title: string; eyebrow: string; footer?: string }) {
  const empty = st.kind === 'quiet' || !st.items.length;
  return `<div class="issue"><div class="issue-head"><div class="row" style="justify-content:space-between"><span class="eyebrow">${esc(o.eyebrow)}</span>${st.fixture ? '<span class="stamp" style="color:var(--warn)">Fictional fixtures</span>' : ''}</div>
  <h3>${esc(o.title)}</h3>
  <div class="meta"><span><b>Period</b> ${fmtDate(st.periodFrom, st.tz)} – ${fmtDate(st.periodTo, st.tz)}</span><span><b>Depth</b> ${esc(st.depth)}</span><span><b>Length</b> ${esc(st.length)}</span></div>
  <div class="meta"><span><b>Interests</b> ${esc(st.interests.join(', '))}</span></div>
  ${st.limitations.length ? `<div class="note warn small"><b>Coverage limits</b><ul style="margin:4px 0 0;padding-left:18px">${st.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>` : ''}</div>
  <div class="issue-body">${st.kind === 'notice' ? '<div class="story"><p>Several sources failed to refresh, so we skipped a normal issue. This notice doesn’t use a free issue.</p></div>'
    : empty ? `<div class="story"><h3>No verified changes ${st.kind === 'sample' ? 'matched' : 'this week'}</h3><p>${st.kind === 'sample' ? 'Nothing in this period matched your area, interests and sources. We don’t fill the space with unrelated news.' : `All ${st.coverageOk} of your sources refreshed successfully.`}</p></div>`
    : st.items.map((it, i) => storyHtml(it, i, prefs.len)).join('') + (st.briefs.length ? `<div class="story"><h4>Brief mentions</h4><ul class="briefs">${st.briefs.map((b) => `<li><b>${esc(b.name)}</b>: ${esc(b.status)}. <span class="muted">≈${b.distanceMi.toFixed(1)} mi · ${esc(b.evidenceLabel)} · <a href="${esc(b.sources[0]?.url)}" rel="noopener noreferrer">source</a></span></li>`).join('')}</ul></div>` : '')}</div>
  ${o.footer ? `<div class="issue-foot">${o.footer}</div>` : ''}</div>`;
}

export function samplePage(app: App, d: Draft, max: number, pv: Preview | null, o: { error?: string; blockers: string[]; plan?: { diff: DiffRow[]; token: string; message: string | null } | null; text?: string; approved: boolean }) {
  const p = d.prefs!;
  const stale = pv && pv.status === 'ready' && JSON.stringify(pv.prefs) !== JSON.stringify(p);
  let main = '';
  if (o.blockers.length) main = `<div class="card stack"><h3>Before we build your sample</h3><ul>${o.blockers.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>`;
  else if (!pv) main = `<div class="card stack"><h3>Ready to build your sample</h3><p>We'll match the last ${app.cfg.lookbackDays} days of verified records to your settings.</p><form method="post" action="/start/sample"><input type="hidden" name="action" value="generate"><button class="btn primary">Generate sample</button></form></div>`;
  else if (pv.status === 'running') main = `<div class="card stack" role="status"><h3>Building your sample</h3><p>Checking sources, matching changes to your area and verifying every citation. This page refreshes on its own.</p><p class="hint">You can leave; your draft is saved for 24 hours.</p></div>`;
  else if (pv.status !== 'ready') main = `<div class="card stack" role="alert"><h3>${pv.status === 'timeout' ? 'Generation timed out' : 'We couldn’t build a sample'}</h3><p>${esc(pv.error ?? 'Nothing was created.')} This attempt doesn't count against your limit.</p><form method="post" action="/start/sample"><input type="hidden" name="action" value="generate"><button class="btn primary">Try again</button></form></div>`;
  else {
    const st = pv.issue!;
    const pins = st.items.map((i) => i.geom).filter((g): g is NonNullable<typeof g> => !!g);
    main = (pins.length ? `<div class="mapwrap small">${mapSvg(areaOf(pv.prefs), { label: `Map of ${pins.length} sample items; numbers match the stories`, pins, basemap: basemap(app) })}<span class="mapcap">Numbers match the stories below</span></div>` : '')
      + issueBlock(app, st, pv.prefs, { title: `What changed in your ${areaLabelOf(pv.prefs)}`, eyebrow: `Nearby · sample v${pv.version}${pv.cached ? ' · from cache' : ''}`, footer: `<span>This sample covers ${app.cfg.lookbackDays} days. Weekly issues cover one week and are usually shorter.</span><span>${pv.content!.total} matching change${pv.content!.total === 1 ? '' : 's'}. Distances are straight-line and approximate.</span>` });
    if (!st.items.length) main += `<div class="card stack"><p>Try one of these, or join the waitlist if you'd rather wait:</p><form method="post" action="/start/sample" class="btnrow"><input type="hidden" name="action" value="quick"><button class="btn sm" name="op" value="r2">Widen to 2 miles</button><button class="btn sm" name="op" value="allcats">Add all categories</button><button class="btn sm" name="op" value="deep">Use deep research</button></form></div>`;
  }
  const ready = pv && pv.status === 'ready' && !stale;
  const side = `<aside class="side">${ready ? `<div class="panel stack-s"><span class="lbl">Happy with this sample?</span>${o.approved ? `<p class="small">${pill('Approved', 'ok')} Sample v${pv!.version} is approved.</p><a class="btn primary" href="/start/signup">Continue to sign up</a>` : `<form method="post" action="/start/sample"><input type="hidden" name="action" value="approve"><input type="hidden" name="preview" value="${esc(pv!.id)}"><button class="btn primary" ${pv!.content!.main.length ? '' : 'disabled'}>Looks good — start my 3 free issues</button></form>${pv!.content!.main.length ? '' : '<p class="hint">An empty sample can’t start a trial. Change your settings or join the waitlist.</p>'}`}<a class="btn" href="#refine">Make changes</a><p class="hint">Approval applies to this exact version. Any change asks you to approve again.</p></div>` : ''}
  <div class="panel stack-s"><span class="lbl">Sample budget</span><p class="small"><b>${Math.max(0, 3 - d.gens)} of 3</b> generations left for this draft.</p><p class="hint">Unchanged settings reuse the cached sample. Failed attempts don't count. Creating an account doesn't reset this limit.</p></div></aside>`;
  const refine = ready || stale ? `<div class="card stack" id="refine"><h3>Make changes</h3>
   <form method="post" action="/start/sample" class="stack-s"><input type="hidden" name="action" value="refine"><div class="field"><label for="rtext">What would you like changed?</label><textarea id="rtext" name="text">${esc(o.text ?? '')}</textarea></div>
   <div class="chips">${['Only food', 'Less detail', 'Exclude everything north of Mockingbird', 'Show permits only when construction is approved', 'Make it 2 miles'].map((t) => `<button type="button" class="chip" data-fill="${esc(t)}" data-target="rtext">${esc(t)}</button>`).join('')}</div>
   <div><button class="btn sm primary">Show proposed changes</button></div></form>
   ${o.plan?.message ? `<p class="hint" role="status">${esc(o.plan.message)}</p>` : ''}
   ${o.plan?.diff.length ? `<div class="stack-s"><span class="lbl">Proposed settings change</span>${diffTable(o.plan.diff)}<form method="post" action="/start/sample" class="btnrow"><input type="hidden" name="action" value="apply"><input type="hidden" name="plan" value="${esc(o.plan.token)}"><button class="btn primary sm">Apply and regenerate</button><a class="btn sm" href="/start/sample">Cancel</a></form></div>` : ''}
   <div class="stack-s"><span class="lbl">Or edit settings directly</span><div class="btnrow"><a class="btn sm" href="/start/interests">Interests</a><a class="btn sm" href="/start/area">Area</a><a class="btn sm" href="/start/depth">Depth and length</a></div>
   <form method="post" action="/start/sample" class="field"><input type="hidden" name="action" value="status"><label for="smin">Minimum status (advanced)</label><select id="smin" name="statusMin" data-autosubmit>${STATUS_OPTS.map((s) => `<option value="${s.v}" ${(p.statusMin || '') === s.v ? 'selected' : ''}>${esc(s.t)}</option>`).join('')}</select><button class="btn sm" style="margin-top:6px">Apply filter</button></form></div></div>` : '';
  return flow(5, max, `${head(5, 'Your sample newsletter')}${errBox(o.error)}
  ${stale ? `<div class="note warn stack-s"><p><b>Your settings changed since sample v${pv!.version}.</b> Regenerate to see them. Any earlier approval no longer applies.</p>${diffTable(diffPrefs(pv!.prefs, p))}<form method="post" action="/start/sample" class="btnrow"><input type="hidden" name="action" value="generate"><button class="btn primary sm">Regenerate sample</button></form></div>` : ''}
  <div class="preview-layout"><div class="stack">${main}${refine}</div>${side}</div>`);
}

export const diffTable = (rows: DiffRow[]) => `<div class="tablewrap"><table class="diff"><thead><tr><th>Setting</th><th>Now</th><th>Proposed</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r[0])}</td><td class="from">${esc(r[1])}</td><td class="to">${esc(r[2])}</td></tr>`).join('')}</tbody></table></div>`;

export function prefSummary(app: App, p: Prefs) {
  return `<dl class="kv small"><dt>Area</dt><dd>${esc(areaLabelOf(p))}${p.areaMode === 'custom' ? ` · ${p.inc.length} added, ${p.exc.length} excluded` : ''}</dd><dt>Interests</dt><dd>${esc(p.cats.map(catName).join(', '))}${p.evAll ? ' · events across all categories' : ''}</dd><dt>Depth</dt><dd>${esc(depthLabel(p))} (${effectiveFams(p, app.registry.available).length} working sources)</dd><dt>Length</dt><dd>${LENS[p.len].name}</dd>${p.statusMin ? `<dt>Minimum status</dt><dd>${esc(statusText(p.statusMin))}</dd>` : ''}<dt>Schedule</dt><dd>Sundays, 9:00 am Central</dd></dl>`;
}

export function signupPage(app: App, d: Draft, pv: Preview, firstIssue: number, o: { errors?: Record<string, string>; email?: string; error?: string }) {
  const e = o.errors ?? {};
  return flow(6, 6, `${head(6, 'Get your next 3 weekly issues free', 'No card required. After that, choose a paid plan to keep receiving updates.')}${errBox(o.error)}
  <div class="area-layout"><form class="card stack" method="post" action="/start/signup" novalidate>
   <div class="field"><label for="email">Email</label><input type="email" id="email" name="email" autocomplete="email" value="${esc(o.email ?? '')}" ${e.email ? 'aria-invalid="true" aria-describedby="email-e"' : ''}>${e.email ? `<p class="err" id="email-e">${esc(e.email)}</p>` : ''}</div>
   <label class="check"><input type="checkbox" name="consent" value="1" ${e.consent ? 'aria-invalid="true"' : ''}><span>Send me the Nearby weekly newsletter for the area and settings shown here. I can unsubscribe in one click from any issue.</span></label>${e.consent ? `<p class="err">${esc(e.consent)}</p>` : ''}
   <label class="check"><input type="checkbox" name="marketing" value="1"><span>Also send occasional product news (optional)</span></label>
   <p class="small">By signing up you agree to the <a href="/legal/terms">Terms</a> and <a href="/legal/privacy">Privacy policy</a>.</p>
   <div class="btnrow"><button class="btn primary">Email me a confirmation link</button><a class="btn" href="/start/sample">Back to sample</a></div>
   <p class="hint">We confirm your email before scheduling anything. If you confirm before the Saturday 9:00 am cutoff, your first issue arrives <b>${esc(fmtDateTime(firstIssue, app.cfg.tz))}</b>.</p></form>
  <div class="panel stack-s"><span class="lbl">What you're approving (sample v${pv.version})</span>${prefSummary(app, pv.prefs)}<div class="mapwrap small">${mapSvg(areaOf(pv.prefs), { label: 'Your saved area', basemap: basemap(app) })}</div></div></div>`);
}

export function checkEmailPage(app: App, email: string, firstIssue: number) {
  return flow(6, 6, `${head(6, 'Check your email')}
  <p>We sent a confirmation link to <b>${esc(email)}</b>. It works once and expires in 15 minutes.</p>
  <p class="hint">Your free issues start ${esc(fmtDateTime(firstIssue, app.cfg.tz))} if you confirm before the Saturday 9:00 am cutoff. Otherwise they start the following Sunday.</p>
  ${app.cfg.mode === 'fixture' ? note('Fixture mode: no email was sent. Open <a href="/dev#outbox">Dev tools → Outbox</a> to click the link.', 'fix') : ''}
  <form method="post" action="/start/signup/resend"><button class="btn sm">Send a new link</button></form>`);
}

/* ---------------- account ---------------- */
const BILL: Record<string, [string, string]> = { trial_active: ['Free trial', 'ok'], trial_exhausted: ['Trial complete', 'warn'], checkout_pending: ['Waiting for payment confirmation', 'info'], paid_active: ['Paid, active', 'ok'], past_due: ['Payment failed', 'bad'], canceled_pending_expiry: ['Canceled, active until term end', 'warn'], expired: ['Expired', 'bad'] };
const EMS: Record<string, [string, string]> = { active: ['Email on', 'ok'], email_unsubscribed: ['Unsubscribed', 'warn'], suppressed: ['Suppressed after a bounce or complaint', 'bad'] };

export function accountPage(app: App, a: Account, db: Awaited<ReturnType<typeof import('../services/accounts.ts').dashboard>>, o: { prices: import('../providers/billing.ts').PriceInfo[] | null; flash?: string; error?: string; edit?: { diff: DiffRow[]; token: string; message: string | null } | null; delAsk?: boolean }) {
  const b = BILL[db.state], em = EMS[a.emailState];
  const paidActive = db.sub && ['active', 'canceled_pending_expiry', 'past_due'].includes(db.sub.status);
  const fmtMoney = (p: import('../providers/billing.ts').PriceInfo) => app.billing?.name === 'fake' ? 'Test price (fixture)' : new Intl.NumberFormat('en-US', { style: 'currency', currency: p.currency.toUpperCase() }).format(p.amount / 100);
  const exhausted = ['trial_exhausted', 'expired', 'checkout_pending'].includes(db.state);
  const billing = db.state === 'checkout_pending'
    ? note('You returned from checkout. We’re waiting for the billing provider to confirm payment; returning to this page alone doesn’t activate a plan. Refresh in a moment.')
    : paidActive ? `<dl class="kv small"><dt>Plan</dt><dd>${db.sub!.plan === 'annual' ? 'Annual' : 'Monthly'}</dd><dt>Term</dt><dd>${db.sub!.termStart ? fmtDate(db.sub!.termStart, a.tz) : '—'} – ${db.sub!.termEnd ? fmtDate(db.sub!.termEnd, a.tz) : '—'}</dd><dt>Renewal</dt><dd>${db.sub!.cancelAtEnd ? 'Off. Access continues until the term ends.' : 'On'}</dd></dl>
      <div class="btnrow"><form method="post" action="/account/renewal"><input type="hidden" name="renew" value="${db.sub!.cancelAtEnd ? '1' : '0'}"><button class="btn sm ${db.sub!.cancelAtEnd ? '' : 'danger'}">${db.sub!.cancelAtEnd ? 'Turn renewal back on' : 'Cancel renewal'}</button></form><form method="post" action="/account/portal"><button class="btn sm">Manage card and invoices</button></form></div>
      <p class="hint">Canceling stops renewal only; you keep receiving issues until the term ends. Unsubscribing from email is separate and doesn't cancel billing.</p>`
    : `${!o.prices ? note('Checkout is unavailable because prices aren’t configured yet.', 'warn') : ''}
      <div class="plans">${(['monthly', 'annual'] as const).map((plan) => { const pr = o.prices?.find((x) => x.plan === plan); return `<div class="plan"><b>${plan === 'monthly' ? 'Monthly' : 'Annual'}</b><span class="price">${pr ? esc(fmtMoney(pr)) : '—'}</span><span class="hint">${plan === 'monthly' ? 'Billed monthly, delivered every Sunday, including fifth Sundays.' : 'One calendar-year term. Every Sunday in the term, 52 or 53.'}${pr?.taxBehavior === 'exclusive' ? ' Plus applicable tax.' : ''}</span><span class="hint">Renews automatically until you cancel. Canceling keeps access until the term ends.</span><form method="post" action="/account/checkout"><input type="hidden" name="plan" value="${plan}"><button class="btn sm ${exhausted ? 'primary' : ''}" ${pr && exhausted ? '' : 'disabled'}>Choose ${plan}</button></form></div>`; }).join('')}</div>
      ${!exhausted ? '<p class="hint">Plans become available after your 3 free issues. Nothing is charged automatically.</p>' : ''}`;
  return `<div class="stack">${o.flash ? note(esc(o.flash), 'ok') : ''}${errBox(o.error)}
  <div class="row" style="justify-content:space-between"><div class="stack-s"><span class="eyebrow">Signed in</span><h2>${esc(a.email)}</h2></div><div class="row">${pill(b[0], b[1])}${pill(em[0], em[1])}${a.paused ? pill('Paused', 'warn') : ''}<form method="post" action="/logout"><button class="btn sm ghost">Sign out</button></form></div></div>
  ${a.emailState === 'email_unsubscribed' && paidActive && !db.sub!.cancelAtEnd ? `<div class="note warn"><b>You're still on a paid plan.</b> Unsubscribing stopped emails but didn't cancel billing. <form method="post" action="/account/renewal" class="inline"><input type="hidden" name="renew" value="0"><button class="btn sm danger">Cancel renewal</button></form></div>` : ''}
  ${db.state === 'past_due' ? note('Your last payment failed. Update your card to keep receiving issues after the current term.', 'bad') : ''}
  <div class="dash">
  <section class="panel stack" aria-labelledby="h-status"><h3 id="h-status">Status</h3>
   <dl class="kv"><dt>Free issues</dt><dd><div class="meter" aria-label="${db.used} of 3 free issues used">${[0, 1, 2].map((i) => `<span class="${i < db.used ? 'used' : ''}"></span>`).join('')}</div><span class="small">${db.left} of 3 left</span></dd>
   <dt>Next issue</dt><dd>${db.next ? esc(fmtDateTime(db.next, a.tz)) : `<span class="muted">${a.paused ? 'Paused' : a.emailState !== 'active' ? 'Email is off' : 'None scheduled. Choose a plan to continue.'}</span>`}</dd></dl>
   <div class="stack-s"><span class="lbl">Upcoming Sundays</span><ul class="sched">${db.upcoming.map((u) => `<li><span class="tnum">${esc(fmtDate(u.at, a.tz))}${isFifthSunday(u.at, a.tz) ? ' · 5th Sunday' : ''}</span><span class="muted small">${u.ent === 'trial' ? 'Free issue' : u.ent === 'paid' ? 'Included in plan' : 'Not sending'}</span></li>`).join('')}</ul><p class="hint">Plans deliver every Sunday, including fifth Sundays. Pausing doesn't extend a paid term.</p></div></section>
  <section class="panel stack" aria-labelledby="h-prefs"><h3 id="h-prefs">Preferences <span class="pill">v${a.prefsVersion}</span></h3>${prefSummary(app, a.prefs)}<div class="mapwrap small">${mapSvg(areaOf(a.prefs), { label: 'Your saved area', basemap: basemap(app) })}</div>
   <form method="post" action="/account/prefs" class="stack-s"><input type="hidden" name="action" value="plan"><div class="field"><label for="pe">What would you like changed?</label><textarea id="pe" name="text"></textarea></div>
   <div class="grid2"><div class="field"><label for="pr">Radius</label><select id="pr" name="radius">${RADII.map((r) => `<option value="${r}" ${a.prefs.radiusMi === r ? 'selected' : ''}>${r} mi</option>`).join('')}</select></div><div class="field"><label for="pl">Length</label><select id="pl" name="len">${Object.entries(LENS).map(([k, v]) => `<option value="${k}" ${a.prefs.len === k ? 'selected' : ''}>${v.name}</option>`).join('')}</select></div></div>
   <div><button class="btn sm">Show changes</button></div></form>
   ${o.edit?.message ? `<p class="hint">${esc(o.edit.message)}</p>` : ''}
   ${o.edit?.diff.length ? `${diffTable(o.edit.diff)}<p class="hint">Saved as version ${a.prefsVersion + 1}, effective from the next unsent issue. Free-issue credits don't reset.</p><form method="post" action="/account/prefs"><input type="hidden" name="action" value="save"><input type="hidden" name="plan" value="${esc(o.edit.token)}"><button class="btn primary sm">Confirm changes</button></form>` : ''}</section>
  <section class="panel stack wide" aria-labelledby="h-arch"><h3 id="h-arch">Archive</h3>${db.issues.length ? `<div class="tablewrap"><table class="data"><thead><tr><th>Sunday</th><th>Type</th><th>Status</th><th>Stories</th><th>Credit</th><th></th></tr></thead><tbody>${db.issues.slice().reverse().map((i) => { const led = db.ledger.find((l) => l.issueKey === i.scheduleKey && !l.restoredAt); return `<tr><td class="n">${esc(fmtDate(i.sunday, a.tz))}</td><td>${i.kind === 'notice' ? 'Service notice' : i.kind === 'quiet' ? 'Quiet week' : 'Issue'}</td><td>${pill(i.status, i.status === 'delivered' ? 'ok' : i.status === 'accepted' ? 'info' : 'bad')}</td><td class="n">${i.structured.items?.length ?? 0}</td><td>${led ? (led.creditType === 'trial' ? 'Free issue' : 'Paid') : 'None'}</td><td>${['delivered', 'accepted'].includes(i.status) ? `<a class="btn sm" href="/account/issues/${esc(i.id)}">Open</a>` : ''}</td></tr>`; }).join('')}</tbody></table></div>` : `<p class="muted">No issues yet. Your first arrives ${esc(fmtDateTime(a.firstIssueAt, a.tz))}.</p>`}</section>
  <section class="panel stack" aria-labelledby="h-bill"><h3 id="h-bill">Billing</h3>${billing}</section>
  <section class="panel stack" aria-labelledby="h-email"><h3 id="h-email">Email and account</h3>
   <div class="stack-s"><span class="lbl">Pause</span><p class="small">Stops weekly emails. Pausing doesn't extend a paid term.</p><form method="post" action="/account/pause"><input type="hidden" name="paused" value="${a.paused ? '0' : '1'}"><button class="btn sm">${a.paused ? 'Resume emails' : 'Pause emails'}</button></form></div>
   <div class="stack-s"><span class="lbl">Unsubscribe</span><p class="small">Stops all newsletter email right away, including queued sends.${paidActive ? ' It doesn’t cancel your paid plan.' : ''}</p>${a.emailState === 'active' ? `<form method="post" action="/account/unsubscribe"><button class="btn sm">Unsubscribe</button></form>` : a.emailState === 'email_unsubscribed' ? `<form method="post" action="/account/resubscribe" class="stack-s"><label class="check small"><input type="checkbox" name="consent" value="1"><span>Send me the weekly newsletter again</span></label><div><button class="btn sm">Resubscribe</button></div></form>` : '<p class="hint">Email to this address bounced or was marked as spam, so sending is suppressed.</p>'}</div>
   <div class="stack-s"><span class="lbl">Delete account</span><p class="small">Removes your address, preferences and archive. Billing records required by law are kept.</p>${o.delAsk ? `<div class="note bad stack-s"><p><b>Delete this account?</b> This can't be undone.${paidActive ? ' Your paid plan will be canceled.' : ''}</p><form method="post" action="/account/delete" class="btnrow"><input type="hidden" name="confirm" value="1"><button class="btn sm danger">Delete permanently</button><a class="btn sm" href="/account">Keep account</a></form></div>` : `<form method="get" action="/account"><input type="hidden" name="delete" value="1"><button class="btn sm danger">Delete account</button></form>`}</div></section>
  </div></div>`;
}

export function issuePage(app: App, a: Account, i: Issue, plain: boolean) {
  return `<div class="stack"><div class="row" style="justify-content:space-between"><div><span class="eyebrow">Archive</span><h2>${esc(i.subject)}</h2></div><div class="btnrow"><a class="btn sm" href="?${plain ? '' : 'plain=1'}">${plain ? 'HTML view' : 'Plain text'}</a><a class="btn sm ghost" href="/account">Back</a></div></div>
  ${plain ? `<pre class="plain">${esc(i.text)}</pre>` : issueBlock(app, i.structured, a.prefs, { title: i.kind === 'notice' ? 'We skipped this week' : `This week in your ${i.structured.areaLabel}`, eyebrow: `Sunday ${fmtDate(i.sunday, a.tz)} · preferences v${i.prefsVersion}` })}</div>`;
}

export const simplePage = (title: string, body: string) => `<div class="card stack" style="max-width:620px"><h2>${esc(title)}</h2>${body}</div>`;

export function loginPage(o: { sent?: boolean; error?: string; operator?: boolean }) {
  return simplePage(o.operator ? 'Operator sign in' : 'Sign in', o.sent ? `<p>If that address has an account, we sent a sign-in link. It works once and expires in 15 minutes.</p>` : `${errBox(o.error)}<form method="post" action="${o.operator ? '/ops/login' : '/login'}" class="stack"><div class="field"><label for="le">Email</label><input type="email" id="le" name="email" autocomplete="email" required></div><div><button class="btn primary">Email me a sign-in link</button></div><p class="hint">Sign-in is passwordless.${o.operator ? '' : ' New here? <a href="/">Create a sample first</a>.'}</p></form>`);
}

/* ---------------- status ---------------- */
export function statusPage(app: App) {
  const blockers = configBlockers(app.cfg);
  return `<div class="stack" style="max-width:980px"><div class="stack-s"><span class="eyebrow">Coverage and status</span><h2>${esc(app.cfg.coverage.name)}</h2><p class="muted">Mode: <b>${app.cfg.mode}</b>. Store: ${app.cfg.store}. Review: ${app.cfg.reviewMode === 'all' ? 'every change is approved by an operator' : 'only flagged changes need an operator'}.</p></div>
  <div class="panel stack-s"><h3>Sources</h3><div class="tablewrap"><table class="data"><thead><tr><th>Source family</th><th>Status</th><th>Details</th></tr></thead><tbody>${FAMILIES.map((f) => `<tr><td>${esc(f.name)}</td><td>${app.registry.available.has(f.id) ? pill('Available', 'ok') : pill('Unavailable', 'bad')}</td><td class="small">${app.registry.available.has(f.id) ? esc(app.registry.adapters.filter((x) => x.family === f.id).map((x) => `${x.name} (${x.source})`).join('; ') || 'Entered by operators from public announcements') : esc(app.registry.reasons[f.id] ?? '')}</td></tr>`).join('')}</tbody></table></div></div>
  <div class="panel stack-s"><h3>Blocked until configured</h3>${blockers.length ? `<div class="tablewrap"><table class="data"><thead><tr><th>Feature</th><th>Needs</th><th>Until then</th></tr></thead><tbody>${blockers.map((b) => `<tr><td>${esc(b.feature)}</td><td class="mono small">${esc(b.missing.join(', '))}</td><td class="small">${esc(b.effect)}</td></tr>`).join('')}</tbody></table></div>` : '<p>Nothing blocked.</p>'}</div></div>`;
}
