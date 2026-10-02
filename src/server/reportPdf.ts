/** Branded PDF version of a finished report. */
import type { App } from '../app.ts';
import type { Report } from '../store/types.ts';
import type { IssueItem } from '../domain/issue.ts';
import { groupOf, reportSections } from '../domain/groups.ts';
import type { Group } from '../domain/groups.ts';
import { fmtDate } from '../domain/time.ts';
import { hex, Pdf, textWidth, wrap } from '../lib/pdf.ts';
import type { Font, RGB } from '../lib/pdf.ts';

const C = { accent: hex('#1C6A4F'), accentSoft: hex('#DCEBE3'), ink: hex('#15211C'), muted: hex('#56655E'), line: hex('#C9D3CC'), mark: hex('#F2C335'), markSoft: hex('#FBEFC4'), warn: hex('#8F5600'), white: [255, 255, 255] as RGB };
const M = 48; // page margin
const delayed = (it: IssueItem) => !!it.before || /delay|postpon|pushed back|later than/i.test(it.status);

export function reportPdf(app: App, r: Report): Buffer {
  const st = r.issue!;
  const site = app.cfg.baseUrl;
  const host = site.replace(/^https?:\/\//, '');
  const title = `What's changing in your ${st.areaLabel}`;
  const pdf = new Pdf(`Nearby report: ${st.areaLabel}`);
  const right = pdf.W - M;
  const width = right - M;
  let y = 0;

  const newPage = (first = false) => {
    pdf.addPage();
    if (first) {
      pdf.rect(0, pdf.H - 92, pdf.W, 92, C.accent);
      // Logo mark: target ring with a dot.
      pdf.circle(M + 13, pdf.H - 46, 13, C.white);
      pdf.circle(M + 13, pdf.H - 46, 10, C.accent);
      pdf.circle(M + 13, pdf.H - 46, 4, C.white);
      pdf.text(M + 34, pdf.H - 47, 'Nearby', 'F2', 24, C.white);
      pdf.text(M + 34, pdf.H - 64, "What's changing near you, researched and cited", 'F1', 10, C.accentSoft);
      const w = textWidth(host, 'F2', 10);
      pdf.text(right - w, pdf.H - 47, host, 'F2', 10, C.white);
      pdf.link(right - w, pdf.H - 50, w, 14, site);
      y = pdf.H - 92 - 34;
    } else {
      pdf.text(M, pdf.H - 34, 'Nearby', 'F2', 11, C.accent);
      pdf.text(M + 50, pdf.H - 34, title, 'F1', 9, C.muted);
      pdf.line(M, pdf.H - 42, right, pdf.H - 42, C.line);
      y = pdf.H - 62;
    }
  };
  const ensure = (h: number) => { if (y - h < 64) newPage(); };
  const para = (s: string, font: Font, size: number, color: RGB, x = M, w = width, lead = 1.35) => {
    for (const l of wrap(s, font, size, w)) { ensure(size * lead); pdf.text(x, y, l, font, size, color); y -= size * lead; }
  };

  newPage(true);
  para(title, 'F2', 20, C.ink, M, width, 1.2);
  y -= 2;
  para(`Covers ${fmtDate(st.periodFrom, st.tz)} to ${fmtDate(st.periodTo, st.tz)} and what's coming up  ·  Depth: ${st.depth}  ·  Interests: ${st.interests.join(', ')}`, 'F1', 8.5, C.muted);
  y -= 6;
  if (r.summary) { para(r.summary, 'F1', 10.5, C.ink, M, width, 1.45); y -= 4; }

  const all = st.items;
  if (!all.length) {
    y -= 10;
    para('We didn’t find anything we could verify and place inside your area.', 'F2', 12, C.ink);
  }

  const sectionHead = (name: string, g: Group | null) => {
    ensure(70);
    y -= 14;
    const color = g ? hex(g.color) : C.mark;
    pdf.rect(M, y - 3, 4, 16, color);
    pdf.text(M + 12, y, name, 'F2', 13, C.ink);
    y -= 10;
    pdf.line(M, y, right, y, C.line);
    y -= 16;
  };

  const item = (it: IssueItem, num: number, showGroup: boolean) => {
    const g = groupOf(it);
    const nameLines = wrap(it.name, 'F2', 11.5, width - 30);
    const meta = `${it.place}  ·  ~${it.distanceMi < 0.1 ? '<0.1' : it.distanceMi.toFixed(1)} mi${showGroup ? `  ·  ${g.name}` : ''}${it.isEvent ? '  ·  Opening event' : ''}`;
    const metaLines = wrap(meta, 'F1', 8.5, width - 30);
    const status = `${delayed(it) ? 'Changed: ' : ''}${it.status}${it.date && it.date.text !== it.status ? `  (${it.date.text}${it.date.est ? ', estimate' : ''})` : ''}${it.before && it.after ? `  ·  was ${it.before}, now ${it.after}` : ''}`;
    const statusLines = wrap(status, 'F2', 9.5, width - 30);
    const body = `${it.summary}${it.why && it.why !== it.summary ? ` ${it.why}` : ''}`;
    const bodyLines = wrap(body, 'F1', 9.5, width - 30);
    const h = nameLines.length * 14 + metaLines.length * 11 + statusLines.length * 12.5 + bodyLines.length * 13 + 30;
    ensure(Math.min(h, 300));
    const x = M + 30;
    // Number badge in the group's color.
    pdf.circle(M + 10, y + 4, 10, hex(g.color));
    const ns = String(num);
    pdf.text(M + 10 - textWidth(ns, 'F2', 9) / 2, y + 0.8, ns, 'F2', 9, C.white);
    for (const l of nameLines) { ensure(14); pdf.text(x, y, l, 'F2', 11.5, C.ink); y -= 14; }
    for (const l of metaLines) { ensure(11); pdf.text(x, y, l, 'F1', 8.5, C.muted); y -= 11; }
    y -= 2;
    for (const l of statusLines) { ensure(12.5); pdf.text(x, y, l, 'F2', 9.5, delayed(it) ? C.warn : C.accent); y -= 12.5; }
    for (const l of bodyLines) { ensure(13); pdf.text(x, y, l, 'F1', 9.5, C.ink); y -= 13; }
    // Sources as links.
    ensure(12);
    let sx = x;
    pdf.text(sx, y, 'Sources:', 'F1', 8.5, C.muted);
    sx += textWidth('Sources: ', 'F1', 8.5);
    for (const s of it.sources) {
      const label = s.publisher || 'Source';
      const w = textWidth(label, 'F2', 8.5);
      if (sx + w > right) { y -= 11; ensure(11); sx = x; }
      pdf.text(sx, y, label, 'F2', 8.5, C.accent);
      pdf.link(sx, y - 2, w, 11, s.url);
      sx += w + textWidth('   ', 'F1', 8.5);
    }
    y -= 20;
  };

  if (all.length) {
    const { top, groups } = reportSections(all);
    sectionHead('Most relevant additions and updates', null);
    top.forEach((it, i) => item(it, i + 1, true));
    for (const g of groups) {
      sectionHead(g.group.name, g.group);
      g.items.forEach((it, i) => item(it, g.startAt + i, false));
    }
  }

  if (st.briefs.length) {
    sectionHead('Also on the radar', null);
    for (const b of st.briefs) {
      const line = `${b.name}, ${b.place}: ${b.status}.`;
      const lines = wrap(line, 'F1', 9.5, width - 12);
      ensure(lines.length * 13 + 4);
      pdf.circle(M + 3, y + 3, 2, C.muted);
      for (const l of lines) { pdf.text(M + 12, y, l, 'F1', 9.5, C.ink); y -= 13; }
      if (b.sources[0]) pdf.link(M + 12, y + 11, Math.min(width - 12, textWidth(lines[0], 'F1', 9.5)), 12, b.sources[0].url);
      y -= 3;
    }
  }

  // Call to action.
  ensure(90);
  y -= 16;
  pdf.rect(M, y - 52, width, 64, C.markSoft);
  pdf.rect(M, y - 52, 4, 64, C.mark);
  pdf.text(M + 18, y - 8, 'Get this every week', 'F2', 13, C.ink);
  const cta = `Subscribe with these same filters at ${host}`;
  pdf.text(M + 18, y - 26, cta, 'F1', 10, C.ink);
  pdf.link(M + 18, y - 30, textWidth(cta, 'F1', 10), 14, site);
  pdf.text(M + 18, y - 42, 'Distances are straight-line and approximate. Check the linked sources before acting on anything.', 'F1', 8, C.muted);

  // Footers with page numbers.
  const total = pdf.pages.length;
  const made = `Generated ${fmtDate(r.finishedAt ?? Date.now(), st.tz)}`;
  pdf.pages.forEach((p, i) => {
    pdf.line(M, 44, right, 44, C.line, 0.6, p);
    pdf.text(M, 30, `Nearby  ·  ${host}  ·  ${made}`, 'F1', 8, C.muted, p);
    pdf.link(M, 27, textWidth(`Nearby  ·  ${host}`, 'F1', 8), 11, site, p);
    const pn = `Page ${i + 1} of ${total}`;
    pdf.text(right - textWidth(pn, 'F1', 8), 30, pn, 'F1', 8, C.muted, p);
  });
  return pdf.toBuffer();
}
