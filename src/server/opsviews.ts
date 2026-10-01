/** Operator console and fixture dev tools pages. */
import type { App } from '../app.ts';
import type { ChangeEvent } from '../domain/types.ts';
import { catName, CATS, famName } from '../domain/prefs.ts';
import { billingState, trialUsed } from '../domain/ledger.ts';
import { fmtDate, fmtDateTime } from '../domain/time.ts';
import { esc } from './html.ts';
import type { ConsoleMailer } from '../providers/email.ts';

const pill = (t: string, tone = '') => `<span class="pill ${tone}">${esc(t)}</span>`;
const TABS = [['review', 'Review queue'], ['changes', 'All changes'], ['sources', 'Sources'], ['entities', 'Entity matches'], ['manual', 'Add announcement'], ['deliveries', 'Deliveries'], ['subscriptions', 'Subscriptions'], ['audit', 'Audit log']];

function changeRow(app: App, c: ChangeEvent) {
  const tone = c.review === 'approved' ? 'ok' : c.review === 'rejected' ? 'bad' : 'warn';
  return `<tr><td><b>${esc(c.name)}</b><br><span class="hint">${esc(c.status)} · ${esc(catName(c.cat))} · ${esc(c.type)}</span>${c.date ? `<br><span class="hint">Date: ${esc(c.date.text)}${c.date.est ? ' (estimate)' : ''}</span>` : ''}${c.before ? `<br><span class="hint">${esc(c.before)} → ${esc(c.after)}</span>` : ''}${c.conflict ? `<br><span class="hint" style="color:var(--bad)">${c.conflict.map(esc).join('<br>')}</span>` : ''}</td>
  <td class="small">${esc(c.evidenceLabel)}<br><span class="hint">${esc(famName(c.family))}</span></td><td class="n">${esc(fmtDate(c.observedAt, app.cfg.tz))}</td>
  <td>${c.reviewReasons.map((r) => pill(r, 'warn')).join(' ') || '<span class="hint">—</span>'}</td><td>${pill(c.review.replace('_', ' '), tone)}</td>
  <td><div class="stack-s">
   <form method="post" action="/ops/review" class="btnrow"><input type="hidden" name="id" value="${esc(c.id)}"><button class="btn sm" name="decision" value="approved" ${c.review === 'approved' || !c.geom ? 'disabled' : ''}>Approve</button><button class="btn sm" name="decision" value="rejected" ${c.review === 'rejected' ? 'disabled' : ''}>Reject</button></form>
   ${!c.geom ? `<form method="post" action="/ops/locate" class="btnrow"><input type="hidden" name="id" value="${esc(c.id)}"><input type="text" name="address" aria-label="Address for ${esc(c.name)}" placeholder="Street address" required><button class="btn sm">Set location</button></form>` : ''}
   <details><summary class="small">Correct</summary><form method="post" action="/ops/correct" class="stack-s" style="margin-top:6px"><input type="hidden" name="id" value="${esc(c.id)}"><input type="text" name="status" value="${esc(c.status)}" aria-label="Status"><textarea name="summary" aria-label="Summary">${esc(c.summary)}</textarea><input type="text" name="dateText" value="${esc(c.date?.text ?? '')}" aria-label="Date text" placeholder="Date (blank for none)"><label class="check small"><input type="checkbox" name="dateEst" value="1" ${c.date?.est ? 'checked' : ''}><span>Date is an estimate</span></label><button class="btn sm">Save correction</button></form></details>
  </div></td></tr>`;
}
const changeTable = (app: App, list: ChangeEvent[]) => list.length ? `<div class="tablewrap"><table class="data"><thead><tr><th>Change</th><th>Evidence</th><th>Observed</th><th>Flags</th><th>State</th><th>Actions</th></tr></thead><tbody>${list.map((c) => changeRow(app, c)).join('')}</tbody></table></div>` : '<p class="muted">Nothing here.</p>';

export async function opsPage(app: App, tab: string, operator: string, flash?: string, error?: string) {
  const s = app.store;
  let body = '';
  if (tab === 'review') body = changeTable(app, (await s.listChanges({ review: 'needs_review' })).sort((a, b) => b.observedAt - a.observedAt)) + '<p class="hint">Only approved changes reach previews and issues. Unlocated records need a location first. Approving sets the approval time, so the change goes into the next unsent issue.</p>';
  else if (tab === 'changes') body = changeTable(app, (await s.listChanges({ since: app.clock.now() - 90 * 86_400_000 })).sort((a, b) => b.observedAt - a.observedAt).slice(0, 200));
  else if (tab === 'sources') {
    const runs = await s.listAdapterRuns(300);
    body = `<form method="post" action="/ops/refresh"><button class="btn sm">Refresh all sources now</button></form><div class="tablewrap"><table class="data"><thead><tr><th>Adapter</th><th>Family</th><th>Last run</th><th>Last success</th><th>Records</th><th>Error</th></tr></thead><tbody>${app.registry.adapters.map((a) => { const last = runs.find((r) => r.adapter === a.id); const ok = runs.find((r) => r.adapter === a.id && r.ok); return `<tr><td>${esc(a.name)}<br><span class="hint">${esc(a.license)}</span></td><td>${esc(famName(a.family))}</td><td>${last ? `${pill(last.ok ? 'ok' : 'failed', last.ok ? 'ok' : 'bad')} ${esc(fmtDateTime(last.at, app.cfg.tz))}` : '<span class="hint">never</span>'}</td><td class="n">${ok ? esc(fmtDateTime(ok.at, app.cfg.tz)) : '—'}</td><td class="n">${last?.count ?? '—'}</td><td class="small">${esc(last?.error ?? '')}</td></tr>`; }).join('')}</tbody></table></div>
    <h3>Ingestion log</h3><div class="tablewrap"><table class="data"><thead><tr><th>Time</th><th>Adapter</th><th>Result</th></tr></thead><tbody>${runs.slice(0, 40).map((r) => `<tr><td class="n">${esc(fmtDateTime(r.at, app.cfg.tz))}</td><td>${esc(r.adapter)}</td><td class="small">${r.ok ? `${r.count} records` : esc(r.error ?? 'failed')}</td></tr>`).join('')}</tbody></table></div>`;
  } else if (tab === 'entities') {
    const flagged = (await s.listChanges()).filter((c) => c.reviewReasons.some((r) => r.startsWith('Possible duplicate')));
    const ents = await s.listEntities();
    body = `<p class="hint">Records at one address with similar names but different suites are kept apart, because they can be different tenants. Approve to treat as separate, or reject the duplicate.</p>${flagged.length ? `<div class="tablewrap"><table class="data"><thead><tr><th>Change</th><th>Same address, other entities</th></tr></thead><tbody>${flagged.map((c) => { const e = ents.find((x) => x.id === c.entityId); const others = ents.filter((x) => x.id !== c.entityId && x.address && e?.address && x.address.toLowerCase() === e.address.toLowerCase()); return `<tr><td>${esc(c.name)}${e?.suite ? `, Suite ${esc(e.suite)}` : ''}</td><td class="small">${others.map((o) => `${esc(o.canonicalName)}${o.suite ? `, Suite ${esc(o.suite)}` : ''}`).join('<br>') || '—'}</td></tr>`; }).join('')}</tbody></table></div>` : '<p class="muted">No unresolved matches.</p>'}`;
  } else if (tab === 'manual') {
    body = `<form method="post" action="/ops/manual" class="card stack" style="max-width:720px"><p class="hint">Enter a public announcement (company post, press release or public website). It goes through the same change detection and review. Write your own short summary; don't paste the article.</p>
    <div class="grid2"><div class="field"><label for="mf">Source type</label><select id="mf" name="family"><option value="company">Company announcement</option><option value="websites">Public website</option><option value="local_reporting">Local reporting</option></select></div><div class="field"><label for="mc">Category</label><select id="mc" name="cat">${CATS.filter((c) => c.id !== 'events').map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div></div>
    <div class="grid2"><div class="field"><label for="mn">Business or project name</label><input id="mn" name="name" required></div><div class="field"><label for="ma">Street address</label><input id="ma" name="address" required></div></div>
    <div class="grid2"><div class="field"><label for="ms">Suite (optional)</label><input id="ms" name="suite"></div><div class="field"><label for="mst">Stage</label><select id="mst" name="stage"><option value="announced">Announced</option><option value="construction">Under construction</option><option value="open">Open</option><option value="closed">Closed (confirmed)</option></select></div></div>
    <div class="field"><label for="mt">Status line</label><input id="mt" name="statusText" required placeholder="Lease signed"></div>
    <div class="field"><label for="msum">Summary in your own words</label><textarea id="msum" name="summary" required></textarea></div>
    <div class="grid2"><div class="field"><label for="mu">Source link</label><input id="mu" name="url" type="url" required></div><div class="field"><label for="mti">Source title</label><input id="mti" name="title" required></div></div>
    <div class="grid2"><div class="field"><label for="md">Published date</label><input id="md" name="published" type="date" required></div><div class="field"><label for="mo">Opening date text (optional)</label><input id="mo" name="opening" placeholder="Spring 2027"></div></div>
    <label class="check"><input type="checkbox" name="openingEst" value="1" checked><span>Opening date is an estimate</span></label>
    <div><button class="btn primary">Add and send to review</button></div></form>`;
  } else if (tab === 'deliveries') {
    const rows: string[] = [];
    for (const a of await s.listAccounts()) for (const i of (await s.listIssues(a.id)).slice(-10)) rows.push(`<tr><td class="mono small">${esc(a.id)}</td><td class="mono small">${esc(i.scheduleKey)}</td><td>${esc(i.kind)}</td><td>${pill(i.status, i.status === 'delivered' ? 'ok' : i.status === 'accepted' ? 'info' : 'bad')}</td><td class="n">${i.attempts}</td><td>${esc(i.credit)}</td></tr>`);
    body = rows.length ? `<div class="tablewrap"><table class="data"><thead><tr><th>Account</th><th>Issue key</th><th>Kind</th><th>Status</th><th>Attempts</th><th>Credit type</th></tr></thead><tbody>${rows.join('')}</tbody></table></div><p class="hint">Subscriber emails and addresses are not shown here.</p>` : '<p class="muted">No sends yet.</p>';
  } else if (tab === 'subscriptions') {
    const rows: string[] = [];
    for (const a of await s.listAccounts()) {
      const [ledger, b] = await Promise.all([s.listLedger(a.id), s.getBilling(a.id)]);
      const st = billingState({ verifiedAt: a.verifiedAt, consentAt: a.consentAt, emailState: a.emailState, paused: a.paused, firstIssueAt: a.firstIssueAt, checkoutPending: a.checkoutPending, ledger, sub: b?.sub ?? null }, app.clock.now());
      rows.push(`<tr><td class="mono small">${esc(a.id)}</td><td>${esc(st)}</td><td>${esc(a.emailState)}${a.paused ? ' (paused)' : ''}</td><td class="n">${trialUsed(ledger)}/3</td><td class="small">${b?.sub ? `${esc(b.sub.status)} ${b.sub.termEnd ? `until ${esc(fmtDate(b.sub.termEnd, a.tz))}` : ''}` : '—'}</td><td class="small">${esc(b?.log?.[0] ?? '')}</td></tr>`);
    }
    body = rows.length ? `<div class="tablewrap"><table class="data"><thead><tr><th>Account</th><th>Billing</th><th>Email</th><th>Free issues</th><th>Subscription</th><th>Last billing event</th></tr></thead><tbody>${rows.join('')}</tbody></table></div><p class="hint">Operators can't grant consent or change billing here. Billing changes come only from the provider.</p>` : '<p class="muted">No accounts yet.</p>';
  } else {
    const log = await s.listAudit(200);
    body = log.length ? `<div class="tablewrap"><table class="data"><thead><tr><th>Time</th><th>Actor</th><th>Operation</th><th>Detail</th></tr></thead><tbody>${log.map((e) => `<tr><td class="n">${esc(fmtDateTime(e.at, app.cfg.tz))}</td><td class="small">${esc(e.actor)}</td><td>${esc(e.op)}</td><td class="small">${esc(e.detail)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No audited actions yet.</p>';
  }
  return `<div class="stack"><div class="row" style="justify-content:space-between"><div class="stack-s"><span class="eyebrow">Operator · ${esc(operator)}</span><h2>Operator console</h2></div><form method="post" action="/ops/logout"><button class="btn sm ghost">Sign out</button></form></div>
  ${flash ? `<div class="note ok">${esc(flash)}</div>` : ''}${error ? `<div class="note bad" role="alert">${esc(error)}</div>` : ''}
  <nav class="tabs" aria-label="Console sections">${TABS.map(([k, t]) => `<a href="/ops?tab=${k}" style="padding:8px 12px;text-decoration:none;${tab === k ? 'border-bottom:2px solid var(--accent);color:var(--ink)' : 'color:var(--muted)'}" ${tab === k ? 'aria-current="page"' : ''}>${t}</a>`).join('')}</nav>${body}</div>`;
}

export async function devPage(app: App) {
  const outbox = (app.mailer as ConsoleMailer).outbox ?? [];
  const accounts = await app.store.listAccounts();
  const auto = (await app.store.kvGet<boolean>('dev:autoDeliver')) !== false;
  const accepted: string[] = [];
  for (const a of accounts) for (const i of await app.store.listIssues(a.id)) if (i.status === 'accepted' && i.providerMessageId) accepted.push(`<option value="${esc(i.providerMessageId)}">${esc(a.id)} · ${esc(i.scheduleKey)}</option>`);
  return `<div class="stack"><div class="stack-s"><span class="eyebrow">Fixture mode only</span><h2>Dev tools</h2><p class="muted">Clock: <b>${esc(fmtDateTime(app.clock.now(), app.cfg.tz))}</b>${app.clock.offset ? ` (offset ${(app.clock.offset / 86_400_000).toFixed(1)} days)` : ''}</p></div>
  <div class="dash">
  <section class="sim"><h3>Time and sources</h3><form method="post" action="/dev/clock" class="btnrow"><button class="btn sm" name="hours" value="1">+1 hour</button><button class="btn sm" name="hours" value="24">+1 day</button><button class="btn sm" name="hours" value="168">+1 week</button><button class="btn sm" name="next_sunday" value="1">To next Sunday 9:01</button><button class="btn sm ghost" name="reset" value="1">Reset clock</button></form>
   <form method="post" action="/dev/refresh"><button class="btn sm">Refresh fixture sources and reminders</button></form>
   <form method="post" action="/dev/tick"><button class="btn sm primary">Run scheduler and jobs now</button></form><p class="hint">The worker also runs every 30 seconds. Sundays that come due are dispatched once per issue key.</p></section>
  <section class="sim"><h3>Delivery events</h3><form method="post" action="/dev/autodeliver"><input type="hidden" name="on" value="${auto ? '0' : '1'}"><button class="btn sm">${auto ? 'Turn off' : 'Turn on'} automatic delivery</button></form>
   ${accepted.length ? `<form method="post" action="/dev/deliver" class="stack-s"><div class="field"><label for="dm">Accepted message</label><select id="dm" name="messageId">${accepted.join('')}</select></div><div class="btnrow"><button class="btn sm" name="event" value="delivered">Delivered</button><button class="btn sm" name="event" value="bounced_hard">Hard bounce</button><button class="btn sm" name="event" value="complained">Spam complaint</button><button class="btn sm" name="event" value="failed">Failed</button></div></form>` : '<p class="hint">No messages waiting for a delivery event.</p>'}</section>
  <section class="sim"><h3>Billing provider events</h3>${accounts.length ? `<form method="post" action="/dev/billing" class="stack-s"><div class="field"><label for="ba">Account</label><select id="ba" name="account">${accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.id)}</option>`).join('')}</select></div>
   <div class="btnrow"><button class="btn sm" name="kind" value="activate">Subscription active (signed)</button><button class="btn sm" name="kind" value="duplicate">Replay same event</button><button class="btn sm" name="kind" value="invoice_first">Invoice before subscription</button><button class="btn sm" name="kind" value="cancel">Cancel at period end</button><button class="btn sm" name="kind" value="fail">Renewal fails</button><button class="btn sm" name="kind" value="end">Subscription ended</button><button class="btn sm" name="kind" value="badsig">Unsigned event</button></div></form>` : '<p class="hint">Sign up first.</p>'}</section>
  <section class="sim"><h3>Operator</h3><form method="post" action="/dev/operator"><button class="btn sm">Sign in as fixture operator</button></form></section>
  <section class="panel stack wide" id="outbox"><h3>Outbox</h3>${outbox.length ? outbox.slice(0, 20).map((m) => `<details class="box"><summary>${esc(m.subject)} <span class="hint">· ${esc(m.tag)} · ${esc(new Date(m.at).toLocaleString())}</span></summary><div>${m.tag === 'magic_link' ? `<p><a class="btn sm primary" href="${esc((m.text.match(/https?:\/\/\S+/) ?? [''])[0])}">Open the link in this message</a></p>` : ''}<pre class="plain">${esc(m.text)}</pre></div></details>`).join('') : '<p class="muted">No messages yet.</p>'}</section>
  </div></div>`;
}
