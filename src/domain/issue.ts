/**
 * Structured issue building, citation validation and email rendering.
 * Summaries are built only from stored change facts. No item may appear without evidence.
 */
import type { ChangeEvent, DateInfo, IssueContent, Prefs } from './types.ts';
import { catName, depthLabel, LENS } from './prefs.ts';
import { DAY, fmtDate } from './time.ts';
import { metersToMiles } from './geo.ts';

export interface EvidenceRef { id: string; title: string; url: string; recordId: string; family: string; publishedAt: number; observedAt: number }
export interface IssueItem {
  changeId: string; name: string; cat: string; type: ChangeEvent['type']; status: string; summary: string; why?: string;
  before?: string; after?: string; date: DateInfo | null; place: string; distanceMi: number; partly: boolean; late: boolean;
  occurredAt: number | null; evidenceLabel: string; conflict?: string[]; sources: EvidenceRef[]; isEvent: boolean;
  /** Public location of the business or project (never the subscriber's address). */
  geom: import('./types.ts').Geom | null;
}
export interface StructuredIssue {
  kind: 'sample' | 'weekly' | 'quiet' | 'notice';
  areaLabel: string; periodFrom: number; periodTo: number; tz: string;
  interests: string[]; depth: string; length: string;
  limitations: string[]; items: IssueItem[]; briefs: IssueItem[];
  fixture: boolean; coverageOk: number;
}

export const areaLabelOf = (p: Prefs) => `${p.areaMode === 'custom' ? 'custom area' : `${p.radiusMi}-mile area`} near ${p.areaName}`;

export function buildIssue(kind: StructuredIssue['kind'], content: IssueContent, changes: Map<string, ChangeEvent>, evidence: Map<string, EvidenceRef>, p: Prefs,
  ctx: { from: number; to: number; tz: string; limitations: string[]; fixture: boolean; coverageOk: number }): StructuredIssue {
  const toItem = (ci: IssueContent['main'][number]): IssueItem => {
    const c = changes.get(ci.id)!;
    return {
      changeId: c.id, name: c.name, cat: c.cat, type: c.type, status: c.status, summary: c.summary, why: c.why, before: c.before, after: c.after,
      date: c.date ?? null, place: c.place, distanceMi: metersToMiles(ci.dist), partly: ci.partly, isEvent: c.isEvent || c.type === 'reminder',
      late: !!c.occurredAt && c.occurredAt < c.observedAt - 7 * DAY, occurredAt: c.occurredAt ?? null,
      evidenceLabel: c.evidenceLabel, conflict: c.conflict, geom: c.geom, sources: c.evidenceIds.map((id) => evidence.get(id)).filter(Boolean) as EvidenceRef[],
    };
  };
  return {
    kind: kind === 'weekly' && !content.main.length ? 'quiet' : kind,
    areaLabel: areaLabelOf(p), periodFrom: ctx.from, periodTo: ctx.to, tz: ctx.tz,
    interests: p.cats.map(catName), depth: depthLabel(p), length: LENS[p.len].name,
    limitations: ctx.limitations, items: content.main.map(toItem), briefs: content.briefs.map(toItem),
    fixture: ctx.fixture, coverageOk: ctx.coverageOk,
  };
}

/** Reject any item that is not fully grounded in stored, approved changes and their evidence. */
export function validateIssue(issue: StructuredIssue, changes: Map<string, ChangeEvent>, evidence: Map<string, EvidenceRef>): string[] {
  const errs: string[] = [];
  for (const it of [...issue.items, ...issue.briefs]) {
    const c = changes.get(it.changeId);
    if (!c) { errs.push(`${it.name}: no stored change`); continue; }
    if (c.review !== 'approved') errs.push(`${it.name}: change not approved`);
    if (!it.sources.length) errs.push(`${it.name}: no evidence`);
    for (const s of it.sources) {
      if (!c.evidenceIds.includes(s.id) || !evidence.has(s.id)) errs.push(`${it.name}: unknown evidence ${s.id}`);
      if (!/^https?:\/\//.test(s.url)) errs.push(`${it.name}: evidence has no link`);
    }
    if ((it.date?.text ?? null) !== (c.date?.text ?? null)) errs.push(`${it.name}: date differs from evidence`);
    if (it.date && !it.date.est && c.date?.est) errs.push(`${it.name}: estimated date shown as confirmed`);
    if (it.summary !== c.summary || it.status !== c.status) errs.push(`${it.name}: text not from stored facts`);
    if (!c.geom) errs.push(`${it.name}: unlocated`);
  }
  return errs;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
const miles = (m: number) => (m < 0.1 ? '<0.1' : m.toFixed(1));

export function subjectFor(issue: StructuredIssue, sunday: number): string {
  const d = fmtDate(sunday, issue.tz, { year: undefined });
  if (issue.kind === 'notice') return `Nearby service notice · ${d}`;
  if (issue.kind === 'quiet') return `Nearby · ${d} · No verified changes this week`;
  const n = issue.items.length;
  return `Nearby · ${d} · ${n} change${n === 1 ? '' : 's'} near ${issue.areaLabel.replace(/^.* near /, '')}`;
}

export interface RenderLinks { preferences: string; unsubscribe: string; useful?: { yes: string; no: string }; footerNote?: string }

const BRAND = { ink: '#15211C', muted: '#56655E', line: '#C9D3CC', accent: '#1C6A4F', mark: '#F2C335', soft: '#EEF1EC' };

function itemHtml(it: IssueItem, i: number, len: Prefs['len']): string {
  const date = it.date ? `${esc(it.date.text)}${it.date.est ? ' (estimate)' : ''}` : '';
  const src = it.sources.map((s) => `<a href="${esc(s.url)}" style="color:${BRAND.accent}">${esc(s.title)}</a> · ${esc(fmtDate(s.publishedAt))}`).join('<br>');
  const tags = [catName(it.cat), it.evidenceLabel, it.isEvent ? 'Opening event' : '', it.partly ? 'Partly in your area' : '', it.late ? `Late record: happened ${fmtDate(it.occurredAt!)}` : ''].filter(Boolean);
  return `<tr><td style="padding:16px 0;border-bottom:1px solid ${BRAND.line}">
<div style="font-size:12px;color:${BRAND.muted}">${tags.map(esc).join(' · ')}</div>
<div style="font-size:17px;font-weight:700;color:${BRAND.ink};margin:4px 0">${i + 1}. ${esc(it.name)}</div>
<div style="font-size:13px;color:${BRAND.muted}">${esc(it.place)} · about ${miles(it.distanceMi)} mi away (approximate distance)</div>
<p style="margin:8px 0 4px;font-size:15px;color:${BRAND.ink}"><b>${esc(it.status)}.</b> ${esc(it.summary)}</p>
${it.before ? `<p style="margin:4px 0;font-size:14px">Changed from <s>${esc(it.before)}</s> to <b>${esc(it.after)}</b></p>` : ''}
${len !== 'brief' && it.why ? `<p style="margin:4px 0;font-size:14px;color:${BRAND.muted}">${esc(it.why)}</p>` : ''}
${date ? `<p style="margin:4px 0;font-size:14px">Date: ${date}</p>` : ''}
${it.conflict && len !== 'brief' ? `<p style="margin:4px 0;font-size:13px;color:#8F5600">Sources disagree: ${it.conflict.map(esc).join('; ')}</p>` : ''}
<p style="margin:6px 0 0;font-size:13px">Source: ${src}</p></td></tr>`;
}

export function renderHtml(issue: StructuredIssue, links: RenderLinks, len: Prefs['len'] = 'standard'): string {
  const head = issue.kind === 'notice' ? 'We skipped this week' : issue.kind === 'quiet' ? 'No verified changes this week' : `What changed in your ${esc(issue.areaLabel)}`;
  let body = '';
  if (issue.kind === 'notice') body = `<p>Several of our sources failed to refresh, so we didn't send a normal issue. This notice doesn't use a free issue, and this week's changes will appear next time.</p>`;
  else if (issue.kind === 'quiet') body = `<p>None of your ${issue.coverageOk} sources showed a verified change in your area this week. All of them refreshed successfully.</p><p><a href="${esc(links.preferences)}" style="color:${BRAND.accent}">Adjust your preferences</a> if you'd like a wider area or more sources.</p>`;
  else {
    body = `<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${issue.items.map((it, i) => itemHtml(it, i, len)).join('')}</table>`;
    if (issue.briefs.length) body += `<h3 style="font-size:15px;margin:18px 0 6px">Brief mentions</h3><ul style="padding-left:18px;margin:0">${issue.briefs.map((b) => `<li style="margin:4px 0;font-size:14px"><b>${esc(b.name)}</b>: ${esc(b.status)}. <span style="color:${BRAND.muted}">About ${miles(b.distanceMi)} mi · ${esc(b.evidenceLabel)} · <a href="${esc(b.sources[0]?.url)}" style="color:${BRAND.accent}">source</a></span></li>`).join('')}</ul>`;
  }
  const lim = issue.limitations.length ? `<div style="background:#FBEBD2;padding:10px 12px;border-radius:6px;font-size:13px;margin:10px 0"><b>Coverage limits</b><ul style="margin:4px 0 0;padding-left:18px">${issue.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></div>` : '';
  const fixture = issue.fixture ? `<div style="background:${BRAND.mark};padding:6px 10px;font-size:12px;font-weight:700">FICTIONAL FIXTURE DATA. Not real local news.</div>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Nearby</title></head>
<body style="margin:0;background:${BRAND.soft};font-family:Arial,Helvetica,sans-serif;color:${BRAND.ink}">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:16px">
<table role="presentation" width="100%" style="max-width:620px;background:#ffffff;border:1px solid ${BRAND.line};border-radius:8px" cellspacing="0" cellpadding="0"><tr><td style="padding:20px 22px">
${fixture}
<div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${BRAND.muted}">Nearby</div>
<h1 style="font-size:22px;margin:6px 0">${head}</h1>
<div style="font-size:13px;color:${BRAND.muted}">${esc(fmtDate(issue.periodFrom, issue.tz))} to ${esc(fmtDate(issue.periodTo, issue.tz))} · ${esc(issue.depth)} · ${esc(issue.length)}</div>
${lim}${body}
</td></tr><tr><td style="padding:14px 22px;background:${BRAND.soft};font-size:12px;color:${BRAND.muted};border-top:1px solid ${BRAND.line}">
${links.footerNote ? `<p style="margin:0 0 6px">${esc(links.footerNote)}</p>` : ''}
<p style="margin:0">Distances are straight-line and approximate. <a href="${esc(links.preferences)}" style="color:${BRAND.accent}">Preferences</a> · <a href="${esc(links.unsubscribe)}" style="color:${BRAND.accent}">Unsubscribe</a>${links.useful ? ` · Was this useful? <a href="${esc(links.useful.yes)}" style="color:${BRAND.accent}">Yes</a> / <a href="${esc(links.useful.no)}" style="color:${BRAND.accent}">No</a>` : ''}</p>
</td></tr></table></td></tr></table></body></html>`;
}

export function renderText(issue: StructuredIssue, links: RenderLinks): string {
  const L: string[] = [];
  if (issue.fixture) L.push('FICTIONAL FIXTURE DATA. Not real local news.', '');
  L.push(`NEARBY: ${issue.areaLabel}`, `${fmtDate(issue.periodFrom, issue.tz)} to ${fmtDate(issue.periodTo, issue.tz)}`, '');
  if (issue.limitations.length) L.push('Coverage limits:', ...issue.limitations.map((l) => `- ${l}`), '');
  if (issue.kind === 'notice') L.push("We skipped this week because several sources failed to refresh. This doesn't use a free issue.");
  else if (issue.kind === 'quiet') L.push('No verified changes this week.', `All ${issue.coverageOk} of your sources refreshed successfully.`);
  issue.items.forEach((it, i) => {
    L.push(`${i + 1}. ${it.name} (${catName(it.cat)}, about ${miles(it.distanceMi)} mi)`, `   ${it.status}. ${it.summary}`);
    if (it.before) L.push(`   Changed from ${it.before} to ${it.after}`);
    if (it.date) L.push(`   Date: ${it.date.text}${it.date.est ? ' (estimate)' : ''}`);
    for (const s of it.sources) L.push(`   Source: ${s.title}, ${fmtDate(s.publishedAt)}: ${s.url}`);
    L.push(`   Evidence: ${it.evidenceLabel}`, '');
  });
  if (issue.briefs.length) L.push('Brief mentions:', ...issue.briefs.map((b) => `- ${b.name}: ${b.status} (${b.sources[0]?.url ?? ''})`), '');
  if (links.footerNote) L.push(links.footerNote);
  L.push(`Preferences: ${links.preferences}`, `Unsubscribe: ${links.unsubscribe}`);
  return L.join('\n');
}
