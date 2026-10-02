/**
 * Minimal PDF writer: US Letter pages, Helvetica and Helvetica-Bold (built-in, no embedding),
 * text, filled rectangles, lines and link annotations. No dependencies.
 */
export type Font = 'F1' | 'F2';
export type RGB = [number, number, number];

// Advance widths (1/1000 em) for ASCII 32–126 from the standard Helvetica AFM files.
const W_REG = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const W_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];

// Unicode → WinAnsiEncoding for the punctuation that shows up in web text.
const WIN: Record<string, number> = { '€': 0x80, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '™': 0x99 };
const WIN_W: Record<number, number> = { 0x80: 556, 0x85: 1000, 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333, 0x95: 350, 0x96: 556, 0x97: 1000, 0x99: 1000 };

/** Map text to single-byte WinAnsi codes; characters the built-in fonts can't show (emoji etc.) are dropped. */
export function toWinAnsi(s: string): number[] {
  const out: number[] = [];
  for (const ch of s.normalize('NFC')) {
    const cp = ch.codePointAt(0)!;
    if (cp === 0x2248) { out.push(0x7e); continue; } // ≈ → ~
    if (cp === 0x2192) { out.push(0x2d, 0x3e); continue; } // → ->
    if (cp >= 32 && cp <= 126) out.push(cp);
    else if (WIN[ch] !== undefined) out.push(WIN[ch]);
    else if (cp >= 0xa0 && cp <= 0xff) out.push(cp);
    else if (cp === 9 || cp === 10) out.push(32);
  }
  return out;
}

export function textWidth(s: string, font: Font, size: number): number {
  const t = font === 'F2' ? W_BOLD : W_REG;
  let w = 0;
  for (const c of toWinAnsi(s)) w += c >= 32 && c <= 126 ? t[c - 32] : WIN_W[c] ?? 556;
  return (w * size) / 1000;
}

/** Greedy word wrap; very long words are broken. */
export function wrap(s: string, font: Font, size: number, max: number): string[] {
  const words = s.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (let w of words) {
    while (textWidth(w, font, size) > max) {
      let i = w.length - 1;
      while (i > 1 && textWidth(w.slice(0, i), font, size) > max) i--;
      if (line) { lines.push(line); line = ''; }
      lines.push(w.slice(0, i));
      w = w.slice(i);
    }
    const next = line ? `${line} ${w}` : w;
    if (textWidth(next, font, size) <= max) line = next;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

const n = (x: number) => (Math.round(x * 100) / 100).toString();
const col = (c: RGB) => c.map((v) => n(v / 255)).join(' ');
const pdfStr = (s: string) => `(${String.fromCharCode(...toWinAnsi(s)).replace(/[\\()]/g, (m) => `\\${m}`)})`;
export const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

interface Page { ops: string[]; links: { x: number; y: number; w: number; h: number; url: string }[] }

export class Pdf {
  readonly W = 612;
  readonly H = 792;
  pages: Page[] = [];
  private title: string;
  constructor(title: string) { this.title = title; }
  get page(): Page { return this.pages[this.pages.length - 1]; }
  addPage() { this.pages.push({ ops: [], links: [] }); }

  text(x: number, y: number, s: string, font: Font, size: number, color: RGB, page = this.page) {
    page.ops.push(`BT ${col(color)} rg /${font} ${n(size)} Tf ${n(x)} ${n(y)} Td ${pdfStr(s)} Tj ET`);
  }
  rect(x: number, y: number, w: number, h: number, color: RGB, page = this.page) {
    page.ops.push(`${col(color)} rg ${n(x)} ${n(y)} ${n(w)} ${n(h)} re f`);
  }
  line(x1: number, y1: number, x2: number, y2: number, color: RGB, width = 0.6, page = this.page) {
    page.ops.push(`${col(color)} RG ${n(width)} w ${n(x1)} ${n(y1)} m ${n(x2)} ${n(y2)} l S`);
  }
  circle(cx: number, cy: number, r: number, color: RGB, page = this.page) {
    const k = r * 0.5523;
    page.ops.push(`${col(color)} rg ${n(cx + r)} ${n(cy)} m ${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} c ${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)} c ${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} c ${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(cx + r)} ${n(cy)} c f`);
  }
  link(x: number, y: number, w: number, h: number, url: string, page = this.page) {
    if (/^https?:\/\//.test(url)) page.links.push({ x, y, w, h, url });
  }

  toBuffer(): Buffer {
    const objs: string[] = [];
    const add = (body: string) => { objs.push(body); return objs.length; };
    const catalog = add(''); // filled below
    const pagesId = add('');
    const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const kids: number[] = [];
    for (const p of this.pages) {
      const stream = p.ops.join('\n');
      const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
      const annots = p.links.map((l) => add(`<< /Type /Annot /Subtype /Link /Rect [${n(l.x)} ${n(l.y)} ${n(l.x + l.w)} ${n(l.y + l.h)}] /Border [0 0 0] /A << /S /URI /URI ${pdfStr(l.url)} >> >>`));
      kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.W} ${this.H}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R${annots.length ? ` /Annots [${annots.map((a) => `${a} 0 R`).join(' ')}]` : ''} >>`));
    }
    const info = add(`<< /Title ${pdfStr(this.title)} /Producer (Nearby) >>`);
    objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets: number[] = [];
    objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}
