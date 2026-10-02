/** Operator console and dev tools pages. Subscriber addresses and emails are not shown here. */
import type { App } from '../app.ts';
import { catName, famName } from '../domain/prefs.ts';
import { fmtDate, fmtDateTime } from '../domain/time.ts';
import { esc } from './html.ts';
import type { ConsoleMailer } from '../providers/email.ts';

const pill = (t: string, tone = '') => `<span class="pill ${tone}">${esc(t)}</span>`;
const TABS = [['reports', 'Reports'], ['requests', 'Subscription requests'], ['records', 'Official records'], ['sources', 'Feeds'], ['audit', 'Audit log']];
const usd = (n: number) => `$${n.toFixed(2)}`;

export async function opsPage(app: App, tab: string, operator: string, flash?: string, error?: string) {
  const s = app.store;
  let body = '';
  if (tab === 'reports') {
    const list = await s.listReports(100);
    const day = Date.now() - 86_400_000;
    const today = list.filter((r) => r.createdAt > day);
    const cost = today.reduce((t, r) => t + (r.usage?.costUsd ?? 0), 0);
    body = `<p class="small">Last 24 hours: <b>${today.length}</b> reports, <b>${today.filter((r) => r.status === 'ready').length}</b> ready, estimated research cost <b>${usd(cost)}</b>. Daily cap ${app.cfg.research.dailyCap}.</p>
    ${list.length ? `<div class="tablewrap"><table class="data"><thead><tr><th>Started</th><th>Area</th><th>Depth</th><th>Status</th><th>Items</th><th>Left out</th><th>Searches</th><th>Est. cost</th><th>Time</th></tr></thead><tbody>${list.map((r) => `<tr><td class="n">${esc(fmtDateTime(r.createdAt, app.cfg.tz))}</td><td class="small">${esc(r.prefs.areaName)}, ${r.prefs.radiusMi} mi</td><td class="small">${esc(r.prefs.preset)}</td><td>${pill(r.status, r.status === 'ready' ? 'ok' : r.status === 'running' ? 'info' : 'bad')}${r.error ? `<br><span class="hint">${esc(r.error)}</span>` : ''}</td><td class="n">${r.issue ? r.issue.items.length + r.issue.briefs.length : '—'}</td><td class="n" title="${esc(r.dropped.map((d) => `${d.name}: ${d.reason}`).join('\n'))}">${r.dropped.length}</td><td class="n">${r.usage?.searches ?? r.progress.queries.length}</td><td class="n">${r.usage ? usd(r.usage.costUsd) : '—'}</td><td class="n">${r.finishedAt ? `${Math.round((r.finishedAt - r.createdAt) / 1000)}s` : '…'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No reports yet.</p>'}`;
  } else if (tab === 'requests') {
    const list = await s.listSubscriptionRequests(200);
    body = list.length ? `<div class="tablewrap"><table class="data"><thead><tr><th>Requested</th><th>Request id</th><th>Area</th><th>Interests</th><th>Status</th></tr></thead><tbody>${list.map((x) => `<tr><td class="n">${esc(fmtDateTime(x.createdAt, app.cfg.tz))}</td><td class="mono small">${esc(x.id)}</td><td class="small">${esc(x.prefs.areaName)}, ${x.prefs.radiusMi} mi</td><td class="small">${esc(x.prefs.cats.map(catName).join(', '))}</td><td>${pill(x.status.replace('_', ' '), x.status === 'confirmed' ? 'ok' : x.status === 'handed_off' ? 'info' : 'warn')}</td></tr>`).join('')}</tbody></table></div><p class="hint">The subscription service reads confirmed requests from <span class="mono">GET /api/subscription-requests/:id</span> with the hand-off secret.</p>` : '<p class="muted">No subscription requests yet.</p>';
  } else if (tab === 'records') {
    const list = (await s.listChanges({ since: Date.now() - 90 * 86_400_000 })).sort((a, b) => b.observedAt - a.observedAt).slice(0, 200);
    body = `<p class="hint">Official records from the Dallas feeds. Reports pass these to the research as primary sources. Reject a record to keep it out of reports.</p>${list.length ? `<div class="tablewrap"><table class="data"><thead><tr><th>Record</th><th>Source</th><th>Observed</th><th>State</th><th></th></tr></thead><tbody>${list.map((c) => `<tr><td><b>${esc(c.name)}</b><br><span class="hint">${esc(c.status)} · ${esc(catName(c.cat))}${c.geom ? '' : ' · not located'}</span></td><td class="small">${esc(famName(c.family))}</td><td class="n">${esc(fmtDate(c.observedAt, app.cfg.tz))}</td><td>${pill(c.review.replace('_', ' '), c.review === 'rejected' ? 'bad' : 'ok')}</td><td><form method="post" action="/ops/review" class="btnrow"><input type="hidden" name="id" value="${esc(c.id)}">${c.review === 'rejected' ? '<button class="btn sm" name="decision" value="approved">Restore</button>' : '<button class="btn sm" name="decision" value="rejected">Reject</button>'}</form></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No records yet.</p>'}`;
  } else if (tab === 'sources') {
    const runs = await s.listAdapterRuns(300);
    body = `<form method="post" action="/ops/refresh"><button class="btn sm">Refresh all feeds now</button></form><div class="tablewrap"><table class="data"><thead><tr><th>Feed</th><th>Last run</th><th>Last success</th><th>Records</th><th>Error</th></tr></thead><tbody>${app.registry.adapters.map((a) => { const last = runs.find((r) => r.adapter === a.id); const ok = runs.find((r) => r.adapter === a.id && r.ok); return `<tr><td>${esc(a.name)}<br><span class="hint">${esc(a.license)}</span></td><td>${last ? `${pill(last.ok ? 'ok' : 'failed', last.ok ? 'ok' : 'bad')} ${esc(fmtDateTime(last.at, app.cfg.tz))}` : '<span class="hint">never</span>'}</td><td class="n">${ok ? esc(fmtDateTime(ok.at, app.cfg.tz)) : '—'}</td><td class="n">${last?.count ?? '—'}</td><td class="small">${esc(last?.error ?? '')}</td></tr>`; }).join('')}</tbody></table></div>`;
  } else {
    const log = await s.listAudit(200);
    body = log.length ? `<div class="tablewrap"><table class="data"><thead><tr><th>Time</th><th>Actor</th><th>Operation</th><th>Detail</th></tr></thead><tbody>${log.map((e) => `<tr><td class="n">${esc(fmtDateTime(e.at, app.cfg.tz))}</td><td class="small">${esc(e.actor)}</td><td>${esc(e.op)}</td><td class="small">${esc(e.detail)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No audited actions yet.</p>';
  }
  return `<div class="stack"><div class="row" style="justify-content:space-between"><div class="stack-s"><span class="eyebrow">Operator · ${esc(operator)}</span><h2>Operator console</h2></div><form method="post" action="/ops/logout"><button class="btn sm ghost">Sign out</button></form></div>
  ${flash ? `<div class="note ok">${esc(flash)}</div>` : ''}${error ? `<div class="note bad" role="alert">${esc(error)}</div>` : ''}
  <nav class="tabs" aria-label="Console sections">${TABS.map(([k, t]) => `<a href="/ops?tab=${k}" style="padding:8px 12px;text-decoration:none;${tab === k ? 'border-bottom:2px solid var(--accent);color:var(--ink)' : 'color:var(--muted)'}" ${tab === k ? 'aria-current="page"' : ''}>${t}</a>`).join('')}</nav>${body}</div>`;
}

export async function devPage(app: App) {
  const outbox = (app.mailer as ConsoleMailer).outbox ?? null;
  return `<div class="stack"><div class="stack-s"><span class="eyebrow">Development only</span><h2>Dev tools</h2><p class="muted">Research: <b>${esc(app.researcher?.name ?? 'not configured')}</b>${app.researcher?.name === 'anthropic' ? ` (${esc(app.cfg.research.model)})` : ''}. Email: <b>${esc(app.mailer.name)}</b>.</p></div>
  <div class="dash">
  <section class="sim"><h3>Feeds and jobs</h3><form method="post" action="/dev/refresh"><button class="btn sm">Refresh official record feeds</button></form><form method="post" action="/dev/tick"><button class="btn sm">Run scheduled jobs now</button></form></section>
  <section class="sim"><h3>Operator</h3><form method="post" action="/dev/operator"><button class="btn sm">Open the operator console</button></form></section>
  <section class="panel stack wide" id="outbox"><h3>Outbox</h3>${outbox ? (outbox.length ? outbox.slice(0, 20).map((m) => `<details class="box"><summary>${esc(m.subject)} <span class="hint">· to ${esc(m.to)} · ${esc(new Date(m.at).toLocaleString())}</span></summary><div>${(m.text.match(/https?:\/\/\S+/) ?? [])[0] ? `<p><a class="btn sm primary" href="${esc(m.text.match(/https?:\/\/\S+/)![0])}">Open the link in this message</a></p>` : ''}<pre class="plain">${esc(m.text)}</pre></div></details>`).join('') : '<p class="muted">No messages yet.</p>') : '<p class="muted">Real email is configured, so messages go to inboxes.</p>'}</section>
  </div></div>`;
}
