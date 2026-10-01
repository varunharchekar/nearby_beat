/**
 * Dallas City Council legislation through the Legistar Web API (public, no key).
 * Zoning cases: matters whose type starts with "ZONING CASES". Amendments are detected by diffing the case text.
 */
import { extractAddress, observation } from './types.ts';
import type { SourceAdapter } from './types.ts';

const API = 'https://webapi.legistar.com/v1';
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

export function legistarZoning(client = 'cityofdallas', site = 'https://cityofdallas.legistar.com'): SourceAdapter {
  const a: SourceAdapter = {
    id: 'legistar_zoning', family: 'zoning', name: 'Dallas zoning cases (Legistar)',
    source: `${API}/${client}/matters`, license: 'Public municipal records via Legistar Web API',
    async fetch(ctx) {
      const u = new URL(`${API}/${client}/matters`);
      const since = new Date(ctx.since).toISOString().slice(0, 19);
      u.searchParams.set('$filter', `MatterLastModifiedUtc gt datetime'${since}' and substringof('ZONING', MatterTypeName) eq true`);
      u.searchParams.set('$orderby', 'MatterLastModifiedUtc desc');
      u.searchParams.set('$top', '500');
      const r = await ctx.fetch(u, { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`Legistar matters: HTTP ${r.status}`);
      const rows = (await r.json()) as any[];
      const out = [];
      for (const m of rows) {
        const title = norm(m.MatterTitle ?? m.MatterName ?? '');
        const caseNo = title.match(/\b(Z\d{3}-\d{3}(?:\([A-Z]{2,3}\))?)/)?.[1] ?? m.MatterFile ?? `Matter ${m.MatterId}`;
        const status = norm(m.MatterStatusName ?? 'Pending');
        const stage = /approved|adopted|passed/i.test(status) ? 'approved' : 'filed';
        const canceled = /denied|withdrawn|failed/i.test(status);
        const street = extractAddress(title);
        const point = street ? await ctx.geocode(`${street}, Dallas, TX`) : null;
        const short = title.length > 300 ? `${title.slice(0, 297)}…` : title;
        out.push(observation(a, {
          recordId: `matter:${m.MatterId}`,
          url: `${site}/LegislationDetail.aspx?ID=${m.MatterId}&GUID=${m.MatterGuid}`,
          title: `Zoning case ${caseNo}`,
          publishedAt: Date.parse(m.MatterIntroDate ?? m.MatterLastModifiedUtc) || ctx.now, observedAt: ctx.now,
          hashOf: [status, title],
          facts: {
            name: `Zoning case ${caseNo}`, address: street ?? undefined, projectId: `legistar:${client}:${m.MatterId}`, cat: 'dev',
            geom: point ? { type: 'Point', coordinates: point } : null, stage, canceled,
            statusText: status, revision: title,
            summary: `City record: ${short}`,
            why: stage === 'approved' ? 'Council approval changes what can be built. It is not a construction start.' : 'A zoning request is a proposal. It can change or be denied.',
          },
        }));
      }
      return out;
    },
  };
  return a;
}
