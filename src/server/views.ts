/** Server-rendered pages. Plain HTML forms, so every step works without JavaScript or a mouse. */
import type { App } from '../app.ts';
import type { Draft, GeoCandidate, Report } from '../store/types.ts';
import type { Prefs } from '../domain/types.ts';
import { ARTICLE_PRESETS, CATS, catName, depthLabel, depthName, diffPrefs, effectiveFams, FAMILIES, famName, LENS, PRESETS, RADII, STATUS_OPTS, statusText, unavailableSelected } from '../domain/prefs.ts';
import type { DiffRow } from '../domain/prefs.ts';
import { areaOf, extendsBeyondRadius } from '../domain/geo.ts';
import { groupOf, reportSections } from '../domain/groups.ts';
import type { IssueItem } from '../domain/issue.ts';
import { areaLabelOf } from '../domain/issue.ts';
import { fmtDate, fmtDateTime } from '../domain/time.ts';
import { configBlockers } from '../config.ts';
import { esc } from './html.ts';
import { mapboxStatic, mapSvg } from './map.ts';

export interface Page { title: string; body: string; nav?: 'flow' | 'ops' | 'status'; refresh?: number }

export function layout(app: App, p: Page): string {
  const fixture = app.cfg.mode === 'fixture';
  const navLink = (href: string, key: Page['nav'], t: string) => `<a href="${href}" ${p.nav === key ? 'aria-current="page"' : ''}>${t}</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(p.title)} · Nearby</title>${p.refresh ? `<meta http-equiv="refresh" content="${p.refresh}">` : ''}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Familjen+Grotesk:wght@500;600;700&family=Public+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="/static/styles.css"><script src="/static/app.js" defer></script></head><body>
${fixture ? '<div class="ribbon" role="note"><b>Fixture mode</b>Every place, record and story is fictional, and the research is simulated. No real email is sent.</div>' : ''}
<header class="top"><div class="top-in">
<a class="brand" href="/"><svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="12" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="16" cy="16" r="3.4" fill="currentColor"/><path d="M16 1v7M16 24v7M1 16h7M24 16h7" stroke="currentColor" stroke-width="2.4"/></svg>Nearby</a>
<nav class="nav" aria-label="Main">${navLink('/', 'flow', 'Get a report')}${navLink('/status', 'status', 'Sources')}</nav>
${app.cfg.devTools ? '<a class="toolbtn" href="/dev">Dev tools</a>' : ''}
</div></header>
<main class="wrap" id="main">${p.body}</main>
<footer class="footer"><a href="/legal/privacy">Privacy</a><a href="/legal/terms">Terms</a><a href="/status">Sources and status</a></footer>
</body></html>`;
}

const pill = (t: string, tone = '') => `<span class="pill ${tone}">${esc(t)}</span>`;
const note = (t: string, tone = '') => `<div class="note ${tone}">${t}</div>`;
const errBox = (e: string | null | undefined) => (e ? `<div class="note bad flash" role="alert">${esc(e)}</div>` : '');
const basemap = (app: App) => mapboxStatic(app.cfg.geocoder.mapboxToken);

/* ---------------- onboarding ---------------- */
const STEPS = ['Location', 'Interests', 'Depth', 'Report'];
const STEP_URL = ['/start', '/start/interests', '/start/depth', '/start/report'];
function rail(step: number, max: number) {
  return `<nav class="rail" aria-label="Report steps"><ol>${STEPS.map((s, i) => {
    const k = i + 1;
    const inner = `<span class="n">${k}</span><span class="lbl-t">${s}</span>`;
    return `<li>${k <= max && k !== step ? `<a href="${STEP_URL[i]}" class="${k < step ? 'done' : ''}" style="all:unset;box-sizing:border-box;display:flex;gap:10px;align-items:center;padding:8px 10px;border-radius:6px;cursor:pointer;color:var(--muted)">${inner}</a>` : `<button disabled ${k === step ? 'aria-current="step"' : ''}>${inner}</button>`}</li>`;
  }).join('')}</ol></nav>`;
}
export function maxStep(d: Draft | null): number {
  if (!d?.prefs) return 1;
  return d.currentReportId ? 4 : 3;
}
const flow = (step: number, max: number, body: string) => `<div class="flow">${rail(step, max)}<section class="work">${body}</section></div>`;
const head = (step: number, title: string, sub = '') => `<div class="stephead"><span class="eyebrow">Step ${step} of 4</span><h2>${title}</h2>${sub ? `<p class="muted">${sub}</p>` : ''}</div>`;

function radiusField(r: number, auto = false) {
  return `<fieldset class="stack-s" style="border:0;padding:0;margin:0"><legend class="lbl" style="margin-bottom:6px">Radius</legend><div class="row">${RADII.map((x) => `<label class="opt" style="padding:8px 12px"><input type="radio" name="radius" value="${x}" ${r === x ? 'checked' : ''} ${auto ? 'data-autosubmit' : ''}><b>${x} mi</b></label>`).join('')}</div><span class="hint">Straight-line distance from your pin.</span></fieldset>`;
}

export function landing(app: App, o: { error?: string; q?: string; radius?: number }) {
  return `<div class="hero">
  <div class="hero-copy"><span class="eyebrow">Neighborhood research · on demand</span><h1>Find out what's changing nearby.</h1><p class="lead">Openings, closures, construction and development around your address, researched live and cited source by source.</p>
   <div class="hero-facts"><div><span class="mono">01</span><span>Enter an address and pick what you care about.</span></div><div><span class="mono">02</span><span>We research the web and public records for 3 to 5 minutes.</span></div><div><span class="mono">03</span><span>Read your report. Like it? Get it every week.</span></div></div></div>
  <form class="card stack" method="post" action="/start">
   ${errBox(o.error)}
   <div class="field"><label for="q">Your address or nearest intersection</label><input type="text" id="q" name="q" autocomplete="street-address" required value="${esc(o.q ?? '')}" placeholder="Street address, city or ZIP"><span class="hint">${app.geocoder.name === 'census' ? 'Enter a full street address with city and state, like “2000 Greenville Ave, Dallas, TX”.' : 'Include the city or ZIP code. Intersections work too, like “Greenville Ave &amp; Ross Ave, Dallas”.'}</span></div>
   ${app.cfg.mode === 'fixture' ? '<p class="hint">Fixture addresses: 100 Sample Street · Main Street (ambiguous) · Greenville Ave &amp; Mockingbird · 500 Example Road</p>' : ''}
   ${radiusField(o.radius ?? 1)}
   <button class="btn primary" type="submit">Start my report</button>
   <p class="hint">We use your address only to place you on the map and measure distance. The research uses your neighborhood and a rounded location, never your street address. Your search is kept for 24 hours.</p>
  </form></div>`;
}

export function candidatesPage(cands: GeoCandidate[], error?: string) {
  return flow(1, 1, `${head(1, cands.length > 1 ? 'Which one did you mean?' : 'Confirm your location')}${errBox(error)}
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

export function outsidePage(app: App, c: GeoCandidate) {
  return flow(1, 1, `${head(1, `We can't research ${esc(c.city.split(',')[0] || 'that area')} yet`)}
  ${note(app.cfg.coverage ? `${esc(app.cfg.coverage.name)} is supported right now.` : 'Only US addresses are supported right now.')}
  <div><a class="btn" href="/">Try a different address</a></div>`);
}

export function locationDone(app: App, d: Draft, max: number) {
  const p = d.prefs!;
  return flow(1, max, `${head(1, 'Your location')}
  <div class="area-layout"><div class="mapwrap">${mapSvg(areaOf(p), { label: `Your ${p.radiusMi}-mile area`, basemap: basemap(app) })}</div>
  <div class="stack"><div class="panel stack-s"><span class="lbl">Confirmed location</span><p><b>${esc(p.addressLabel)}</b></p><p class="hint">Area name: near ${esc(p.areaName)}. Distances are measured from this pin.</p><div class="btnrow"><a class="btn sm" href="/">Change location</a><a class="btn sm ghost" href="/start/area">Customize the area on a map</a></div></div>
  <form method="post" action="/start/radius" class="stack">${radiusField(p.radiusMi, true)}<div class="stepfoot"><button class="btn sm">Update radius</button><button class="btn primary" name="next" value="1">Continue</button></div></form></div></div>`);
}

export function interestsPage(d: Draft, max: number, error?: string) {
  const p = d.prefs!;
  return flow(2, max, `${head(2, 'What changes would you like to hear about?')}
  <form method="post" action="/start/interests" class="stack">
  ${error ? `<p class="err" role="alert" id="cat-err">${esc(error)}</p>` : ''}
  <div class="row"><button class="btn sm" name="all" value="1">Select all</button><button class="btn sm" name="none" value="1">Clear all</button></div>
  <fieldset class="grid2" style="border:0;padding:0;margin:0" ${error ? 'aria-describedby="cat-err"' : ''}><legend class="sr">Interests</legend>${CATS.map((k) => `<label class="opt"><input type="checkbox" name="cats" value="${k.id}" ${p.cats.includes(k.id) ? 'checked' : ''}><span><b><span aria-hidden="true">${CAT_ICON[k.id]}</span> ${esc(k.name)}</b><span class="hint">${esc(k.ex)}</span>${k.id === 'fitness' ? '<span class="hint" style="color:var(--warn)">Limited coverage: these businesses rarely appear in public records.</span>' : ''}</span></label>`).join('')}</fieldset>
  <label class="check"><input type="checkbox" name="evAll" value="1" ${p.evAll ? 'checked' : ''}><span><b>Events across all categories</b><br><span class="hint">Off by default: you get opening events only for the business types you picked. Unrelated recurring events are always left out.</span></span></label>
  <div class="stepfoot"><a class="btn" href="/start">Back</a><button class="btn primary" name="next" value="1">Continue</button></div></form>`);
}

export function areaPage(app: App, d: Draft, max: number, sum: { sqMi: number; over: boolean; limit: number }, error?: string) {
  const p = d.prefs!;
  const custom = p.areaMode === 'custom';
  const a = areaOf(p);
  const shapeLi = (s: Prefs['inc'][number], kind: 'inc' | 'exc', i: number) => `<li><span class="row" style="gap:8px"><span class="sw ${kind}"></span><span>${kind === 'inc' ? 'Include' : 'Exclude'}: ${esc(s.label)}</span></span><form method="post" action="/start/area" class="inline"><input type="hidden" name="action" value="remove"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="index" value="${i}"><button class="btn ghost sm" aria-label="Remove ${esc(s.label)}">Remove</button></form></li>`;
  return flow(1, max, `${head(1, 'Customize your area')}
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
   <div class="stepfoot"><a class="btn" href="${d.currentReportId ? '/start/report' : '/start'}">Back</a><form method="post" action="/start/area"><input type="hidden" name="action" value="next"><button class="btn primary">Continue</button></form></div>
  </div></div>`);
}

export function depthPage(app: App, d: Draft, max: number, error?: string) {
  const p = d.prefs!;
  if (app.cfg.research.sources === 'articles') {
    const n = app.cfg.research.maxSearches;
    return flow(3, max, `${head(3, 'How far should we dig?', 'We search recent local news, blogs and business announcements. More searches can find more, but they take longer.')}
  ${errBox(error)}
  <form method="post" action="/start/depth" class="stack">
  <fieldset class="grid3" style="border:0;padding:0;margin:0"><legend class="sr">Research depth</legend>${(['ann', 'bal', 'deep'] as const).map((k) => `<label class="opt"><input type="radio" name="preset" value="${k}" ${p.preset === k ? 'checked' : ''}><span><b>${ARTICLE_PRESETS[k].name}${k === 'bal' ? ' <span class="pill">Recommended</span>' : ''}</b><span class="hint">${esc(ARTICLE_PRESETS[k].desc)} Up to ${n[k]} searches.</span></span></label>`).join('')}</fieldset>
  <div class="note small">Reports are based on articles and announcements. They don't check permit, zoning or other government records.</div>
  <fieldset class="stack-s" style="border:0;padding:0;margin:0"><legend class="lbl" style="margin-bottom:6px">Report length</legend><p class="hint">Every item keeps its source, even in Brief.</p>
  <div class="row">${Object.entries(LENS).map(([k, v]) => `<label class="opt" style="padding:8px 12px"><input type="radio" name="len" value="${k}" ${p.len === k ? 'checked' : ''}><span><b>${v.name}</b><span class="hint">Up to ${v.main} items${v.brief ? ` + ${v.brief} brief` : ''}</span></span></label>`).join('')}</div></fieldset>
  <div class="stepfoot"><a class="btn" href="/start/interests">Back</a><div class="btnrow"><button class="btn" name="save" value="1">Save</button><button class="btn primary" name="next" value="1">Run my report</button></div></div>
  <p class="hint">Research takes about 3 to 5 minutes. You can leave the page and come back.</p></form>`);
  }
  const lab = depthLabel(p);
  const un = unavailableSelected(p, app.registry.available);
  return flow(3, max, `${head(3, 'How far should we dig?', 'Depth changes which kinds of sources we search and how many searches we run. It does not promise more stories or more certainty.')}
  ${errBox(error)}
  <form method="post" action="/start/depth" class="stack">
  <fieldset class="grid3" style="border:0;padding:0;margin:0"><legend class="sr">Research depth</legend>${(['ann', 'bal', 'deep'] as const).map((k) => `<label class="opt"><input type="radio" name="preset" value="${k}" ${lab === PRESETS[k].name ? 'checked' : ''}><span><b>${PRESETS[k].name}${k === 'bal' ? ' <span class="pill">Recommended</span>' : ''}</b><span class="hint">${esc(PRESETS[k].desc)}</span></span></label>`).join('')}</fieldset>
  ${lab === 'Custom' ? `<p>${pill('Custom', 'fix')} <span class="hint">You chose individual sources.</span></p>` : ''}
  <details class="box" ${lab === 'Custom' ? 'open' : ''}><summary>Choose individual sources</summary><div><div class="tablewrap"><table class="fams"><thead><tr><th>Source</th><th>Status</th></tr></thead><tbody>
  ${FAMILIES.map((f) => `<tr><td><label class="check"><input type="checkbox" name="fams" value="${f.id}" ${p.fams[f.id] ? 'checked' : ''}><span>${esc(f.name)}</span></label></td><td>${app.registry.available.has(f.id) ? pill('Available', 'ok') : `${pill('Unavailable', 'bad')} <span class="hint">${esc(app.registry.reasons[f.id] ?? '')}</span>`}</td></tr>`).join('')}</tbody></table></div>
  <input type="hidden" name="custom" value="1"><p class="hint">Changing these boxes makes your selection Custom. Choosing a preset above resets them.</p></div></details>
  ${un.length ? `<div class="note warn stack-s"><p><b>Not available yet:</b> ${un.map((f) => esc(famName(f))).join(', ')}. We'll search only the sources that work.</p><label class="check"><input type="checkbox" name="ack" value="1" ${d.ack ? 'checked' : ''}><span>Continue with the available sources</span></label></div>` : ''}
  <div class="note fix small">How we label things: a permit filing is not an approval, an approval is not construction, and a hiring notice is not an opening date.</div>
  <fieldset class="stack-s" style="border:0;padding:0;margin:0"><legend class="lbl" style="margin-bottom:6px">Report length</legend><p class="hint">Separate from depth. Every item keeps its source, even in Brief.</p>
  <div class="row">${Object.entries(LENS).map(([k, v]) => `<label class="opt" style="padding:8px 12px"><input type="radio" name="len" value="${k}" ${p.len === k ? 'checked' : ''}><span><b>${v.name}</b><span class="hint">Up to ${v.main} items${v.brief ? ` + ${v.brief} brief` : ''}</span></span></label>`).join('')}</div></fieldset>
  <div class="stepfoot"><a class="btn" href="/start/interests">Back</a><div class="btnrow"><button class="btn" name="save" value="1">Save</button><button class="btn primary" name="next" value="1">Run my report</button></div></div>
  <p class="hint">Research takes about 3 to 5 minutes. You can leave the page and come back.</p></form>`);
}

export const diffTable = (rows: DiffRow[]) => `<div class="tablewrap"><table class="diff"><thead><tr><th>Setting</th><th>Now</th><th>Proposed</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r[0])}</td><td class="from">${esc(r[1])}</td><td class="to">${esc(r[2])}</td></tr>`).join('')}</tbody></table></div>`;

export function prefSummary(app: App, p: Prefs) {
  return `<dl class="kv small"><dt>Area</dt><dd>${esc(areaLabelOf(p))}${p.areaMode === 'custom' ? ` · ${p.inc.length} added, ${p.exc.length} excluded` : ''}</dd><dt>Interests</dt><dd>${esc(p.cats.map(catName).join(', '))}${p.evAll ? ' · events across all categories' : ''}</dd><dt>Depth</dt><dd>${esc(depthName(p, app.cfg.research.sources))}</dd><dt>Length</dt><dd>${LENS[p.len].name}</dd>${p.statusMin ? `<dt>Minimum status</dt><dd>${esc(statusText(p.statusMin))}</dd>` : ''}<dt>Schedule</dt><dd>Sundays, 9:00 am Central</dd></dl>`;
}

export const simplePage = (title: string, body: string) => `<div class="card stack" style="max-width:620px"><h2>${esc(title)}</h2>${body}</div>`;

/* ---------------- report ---------------- */
const STAGE_TEXT: [Report['progress']['stage'], string][] = [
  ['records', 'Reading official records for your area'],
  ['searching', 'Searching news, business announcements and public sources'],
  ['checking', 'Checking every source'],
  ['placing', 'Placing each item on the map and applying your filters'],
  ['done', 'Report ready'],
];

export function progressPage(app: App, d: Draft, r: Report, now: number) {
  const idx = STAGE_TEXT.findIndex(([k]) => k === r.progress.stage);
  const secs = Math.max(0, Math.round((now - r.createdAt) / 1000));
  const q = r.progress.queries;
  return flow(4, 4, `${head(4, 'Researching your area', `${esc(areaLabelOf(r.prefs))} · usually 3 to 5 minutes`)}
  <div class="card stack" role="status" aria-live="polite">
   <ol class="prog" style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:10px">${STAGE_TEXT.slice(0, 4).map(([, t], i) => `<li><span class="dot ${i < idx ? 'ok' : i === idx ? 'on' : ''}"></span>${esc(t)}</li>`).join('')}</ol>
   ${r.progress.note ? `<p class="hint">${esc(r.progress.note)}</p>` : ''}
   <p class="small muted tnum">${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} elapsed · ${q.length} search${q.length === 1 ? '' : 'es'} · ${r.progress.fetched.length} page${r.progress.fetched.length === 1 ? '' : 's'} read</p>
   ${q.length ? `<details class="box" open><summary>Searches so far</summary><div><ul class="small" style="margin:0;padding-left:18px">${q.slice(-12).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div></details>` : ''}
   <p class="hint">You can leave this page. Your report is kept for 24 hours on this browser.</p>
  </div>`);
}

function chips(it: IssueItem) {
  return `<span class="chips" style="margin-top:6px">${it.sources.map((s) => `<a class="chip srcchip" href="${esc(s.url)}" rel="noopener noreferrer" target="_blank" title="${esc(s.title)}${Number.isFinite(s.publishedAt) ? ` · ${fmtDate(s.publishedAt)}` : ''}">${esc(s.publisher || s.title)}</a>`).join('')}</span>`;
}
const CAT_ICON: Record<string, string> = { food: '🍽️', shops: '🛍️', fitness: '🧘', dev: '🏗️', public: '🌳', events: '🎉' };
const delayed = (it: IssueItem) => !!it.before || /delay|postpon|pushed back|later than/i.test(it.status);

function itemRows(items: IssueItem[], startAt: number) {
  return items.map((it, i) => `<tr>
   <td class="n" data-label="#">${startAt + i}</td>
   <td data-label="Business"><span class="gico" title="${esc(groupOf(it).name)}" aria-label="${esc(groupOf(it).name)}">${groupOf(it).icon}</span><b>${esc(it.name)}</b><span class="hint block">${it.isEvent ? 'Opening event · ' : ''}${esc(it.evidenceLabel)}</span></td>
   <td data-label="Address">${esc(it.place)}<span class="hint block tnum">≈${it.distanceMi < 0.1 ? '<0.1' : it.distanceMi.toFixed(1)} mi away</span></td>
   <td data-label="Latest update"><b>${delayed(it) ? '<span aria-label="Changed">⚠️</span> ' : ''}${esc(it.status)}</b>${it.date ? `<span class="hint block">${esc(it.date.text)}${it.date.est ? ' (estimate)' : ''}</span>` : ''}${it.before && it.after ? `<span class="hint block">Was ${esc(it.before)}, now ${esc(it.after)}</span>` : ''}</td>
   <td data-label="Why it matters">${esc(it.summary)}${it.why && it.why !== it.summary ? ` ${esc(it.why)}` : ''}${chips(it)}</td>
  </tr>`).join('');
}
const table = (items: IssueItem[], startAt: number) => `<div class="tablewrap"><table class="report"><thead><tr><th>#</th><th>Business</th><th>Address</th><th>Latest update</th><th>Why it matters</th></tr></thead><tbody>${itemRows(items, startAt)}</tbody></table></div>`;

export function reportBody(app: App, r: Report) {
  const st = r.issue!;
  const all = st.items;
  const { top, groups } = reportSections(all);
  const pins = all.map((i) => i.geom).filter((g): g is NonNullable<typeof g> => !!g);
  const sections = groups.map((g) => `<section class="stack-s"><h3 class="ghead"><span class="gicon" aria-hidden="true" style="background:${g.group.color}1f">${g.group.icon}</span>${esc(g.group.name)}</h3>${table(g.items, g.startAt)}</section>`).join('');
  return `<div class="stack">
  <div class="issue-head" style="border:1px solid var(--line);border-radius:10px">
   <div class="row" style="justify-content:space-between"><span class="eyebrow">Nearby report${r.version > 1 ? ` · version ${r.version}` : ''}</span><span class="row" style="gap:8px">${st.fixture ? '<span class="stamp" style="color:var(--warn)">Fictional fixtures</span>' : ''}<a class="btn sm" href="/start/report/pdf" download>Download PDF</a></span></div>
   <h2>What's changing in your ${esc(st.areaLabel)}</h2>
   <div class="meta"><span><b>Covers</b> ${fmtDate(st.periodFrom, st.tz)} – ${fmtDate(st.periodTo, st.tz)} and what's coming up</span><span><b>Depth</b> ${esc(st.depth)}</span><span><b>Interests</b> ${esc(st.interests.join(', '))}</span></div>
   ${r.summary ? `<p style="margin-top:6px">${esc(r.summary)}</p>` : ''}
  </div>
  ${!all.length ? `<div class="card stack"><h3>No verified changes found</h3><p>We didn't find anything we could verify and place inside your area. We don't fill the space with unrelated news.</p><p class="hint">Try a wider radius, more interests or deeper research below.</p></div>` : `
  ${pins.length ? `<div class="mapwrap small">${mapSvg(areaOf(r.prefs), { label: `Map of ${pins.length} items; numbers match the tables`, pins, basemap: basemap(app) })}<span class="mapcap">Numbers match the tables</span></div>` : ''}
  <section class="stack-s"><h3>🚨 Most relevant additions / updates</h3>${table(top, 1)}</section>
  ${sections}`}
  ${st.briefs.length ? `<section class="stack-s"><h3>Also on the radar</h3><ul class="briefs">${st.briefs.map((b) => `<li><b>${esc(b.name)}</b> · ${esc(b.place)}: ${esc(b.status)}. ${chips(b)}</li>`).join('')}</ul></section>` : ''}
  ${r.dropped.length ? `<details class="box"><summary>Left out (${r.dropped.length})</summary><div><ul class="small" style="margin:0;padding-left:18px">${r.dropped.map((x) => `<li>${esc(x.name)}: ${esc(x.reason)}</li>`).join('')}</ul></div></details>` : ''}
  <p class="hint">Distances are straight-line and approximate. Every item links to its sources; check them before acting on anything.${r.usage ? ` ${r.usage.searches} searches.` : ''}</p>
  </div>`;
}

export function reportPage(app: App, d: Draft, r: Report, o: { error?: string; sub?: { errors?: Record<string, string>; email?: string; sent?: boolean }; budget: string | null }) {
  const p = d.prefs!;
  const stale = JSON.stringify(r.prefs) !== JSON.stringify(p);
  let main = '';
  if (r.status === 'ready') main = reportBody(app, r);
  else main = `<div class="card stack" role="alert"><h3>${r.status === 'timeout' ? 'The research took too long' : r.status === 'interrupted' ? 'The research was interrupted' : 'We couldn’t finish your report'}</h3><p>${esc(r.error ?? 'Nothing was saved.')} This attempt doesn't count against your limit.</p><form method="post" action="/start/report"><input type="hidden" name="action" value="run"><button class="btn primary">Try again</button></form></div>`;
  const e = o.sub?.errors ?? {};
  const subscribe = r.status === 'ready' ? `<div class="panel stack-s" id="subscribe"><span class="lbl">Get this every week</span>
   ${o.sub?.sent ? `<div class="note ok small">Check your email for a confirmation link. It expires in 60 minutes.${app.cfg.mode === 'fixture' || app.cfg.email.provider === 'console' ? ' (No email service is configured, so the link is in Dev tools → Outbox.)' : ''}</div>` : `
   <p class="small">A weekly email with only what's new, using exactly these filters.</p>
   <form method="post" action="/start/report" class="stack-s" novalidate><input type="hidden" name="action" value="subscribe"><input type="hidden" name="report" value="${esc(r.id)}">
    <div class="field"><label for="sub-email">Email</label><input type="email" id="sub-email" name="email" autocomplete="email" value="${esc(o.sub?.email ?? '')}">${e.email ? `<p class="err">${esc(e.email)}</p>` : ''}</div>
    <label class="check small"><input type="checkbox" name="consent" value="1"><span>Email me about subscribing to weekly updates for this area and these filters.</span></label>${e.consent ? `<p class="err">${esc(e.consent)}</p>` : ''}
    <label class="check small"><input type="checkbox" name="marketing" value="1"><span>Also send occasional product news (optional)</span></label>
    <button class="btn primary">Subscribe</button></form>`}
   <p class="hint">Plans and pricing are shown before you pay. Nothing is charged from this page.</p></div>` : '';
  const radiusOpts = p.areaMode === 'radius'
    ? `<div class="field"><label for="rr">Radius</label><select id="rr" name="radius">${RADII.map((v) => `<option value="${v}" ${v === p.radiusMi ? 'selected' : ''}>${v} mile${v === 1 ? '' : 's'}</option>`).join('')}</select></div>`
    : '<p class="hint">Custom area. <a href="/start/area">Edit the map</a> to change it.</p>';
  const presetOf = (t: 'ann' | 'bal' | 'deep') => (app.cfg.research.sources === 'articles' ? ARTICLE_PRESETS[t] : PRESETS[t]);
  const depthOpts = (['ann', 'bal', 'deep'] as const).map((t) => `<option value="${t}" data-desc="${esc(presetOf(t).desc)}" ${p.preset === t ? 'selected' : ''}>${esc(presetOf(t).name)}</option>`).join('');
  const lenOpts = (Object.keys(LENS) as (keyof typeof LENS)[]).map((k) => `<option value="${k}" ${p.len === k ? 'selected' : ''}>${esc(LENS[k].name)}</option>`).join('');
  const refine = `<div class="panel stack-s" id="refine"><span class="lbl">Change and run again</span>
   <form method="post" action="/start/report" class="stack-s"><input type="hidden" name="action" value="rerun">
    <fieldset class="stack-s" style="border:0;padding:0;margin:0"><legend class="small"><b>Interests</b></legend>
     ${CATS.map((k) => `<label class="check small"><input type="checkbox" name="cats" value="${k.id}" ${p.cats.includes(k.id) ? 'checked' : ''}><span><span aria-hidden="true">${CAT_ICON[k.id]}</span> ${esc(k.name)}</span></label>`).join('')}</fieldset>
    <div class="grid2" style="gap:10px">${radiusOpts}
     <div class="field"><label for="rd">Research depth</label><select id="rd" name="preset" data-desc-target="rd-desc" aria-describedby="rd-desc">${depthOpts}</select><span class="hint" id="rd-desc" aria-live="polite">${esc(presetOf(p.preset).desc)}</span></div>
     <div class="field"><label for="rl">Length</label><select id="rl" name="len">${lenOpts}</select></div></div>
    <div><button class="btn primary sm">Run again</button></div></form>
   ${o.budget ? `<p class="hint">${esc(o.budget)}</p>` : ''}</div>`;
  return flow(4, 4, `${errBox(o.error)}
  ${stale ? `<div class="note warn stack-s"><p><b>Your settings changed since this report.</b> Run it again to see them.</p>${diffTable(diffPrefs(r.prefs, p, app.cfg.research.sources))}<form method="post" action="/start/report"><input type="hidden" name="action" value="run"><button class="btn primary sm">Research again</button></form></div>` : ''}
  ${main}
  <div class="grid2">${subscribe}${refine}</div>`);
}

export function confirmPage(o: { ok: boolean; message: string; handoffUrl?: string | null }) {
  return simplePage(o.ok ? 'You’re on the list' : 'This link didn’t work', `<p>${esc(o.message)}</p>${o.handoffUrl ? `<p><a class="btn primary" href="${esc(o.handoffUrl)}">Choose a plan</a></p>` : ''}<p><a class="btn ghost" href="/">Back to Nearby</a></p>`);
}

/* ---------------- status ---------------- */
export function statusPage(app: App) {
  const blockers = configBlockers(app.cfg);
  const r = app.cfg.research;
  return `<div class="stack" style="max-width:980px"><div class="stack-s"><span class="eyebrow">Sources and status</span><h2>How reports are researched</h2>
  <p class="muted" style="max-width:70ch">Each report runs live research with ${app.cfg.mode === 'fixture' ? 'a simulated researcher over fictional fixtures' : `Claude (${esc(r.model)}) using web search and web fetch`}: up to ${r.maxSearches.ann}, ${r.maxSearches.bal} or ${r.maxSearches.deep} searches depending on depth${r.sources === 'articles' ? `, and up to ${r.maxFetches} page reads. Sources are limited to recent news articles, blogs and business announcements; government and records websites are excluded` : ''}. Items are kept only when the cited source was actually seen during the research and the address can be placed inside your area.</p></div>
  ${r.sources === 'articles' ? '' : `<div class="panel stack-s"><h3>Official record feeds</h3><p class="small muted">These are read before the web research and handed to it as primary records. They cover Dallas only.</p><div class="tablewrap"><table class="data"><thead><tr><th>Feed</th><th>Source</th></tr></thead><tbody>${app.registry.adapters.map((a) => `<tr><td>${esc(a.name)}</td><td class="small">${esc(a.source)}</td></tr>`).join('')}</tbody></table></div></div>`}
  <div class="panel stack-s"><h3>Blocked until configured</h3>${blockers.length ? `<div class="tablewrap"><table class="data"><thead><tr><th>Feature</th><th>Needs</th><th>Until then</th></tr></thead><tbody>${blockers.map((b) => `<tr><td>${esc(b.feature)}</td><td class="mono small">${esc(b.missing.join(', '))}</td><td class="small">${esc(b.effect)}</td></tr>`).join('')}</tbody></table></div>` : '<p>Nothing blocked.</p>'}</div></div>`;
}
