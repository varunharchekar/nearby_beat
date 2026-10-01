/**
 * Texas Alcoholic Beverage Commission open data (data.texas.gov, Socrata, updated daily).
 *  - mxm5-tdpj: pending original applications ("Received" / "In Review")
 *  - 7hf9-qc9f: license information (issued, status changes)
 * Public data; access through the documented SODA API.
 */
import type { Cat } from '../domain/types.ts';
import { observation, parseSocrata, socrataTime, suiteOf, titleCase } from './types.ts';
import type { AdapterContext, SourceAdapter } from './types.ts';

const TYPES: Record<string, [string, Cat]> = {
  MB: ['mixed beverage permit', 'food'], BG: ['wine and beer retailer permit', 'food'], BE: ['beer retail on-premise license', 'food'],
  FB: ['food and beverage certificate', 'food'], N: ['private club permit', 'food'], NB: ['private club permit', 'food'], NE: ['private club permit', 'food'],
  RM: ['mixed beverage restaurant permit', 'food'], BQ: ['wine and beer off-premise permit', 'shops'], BF: ['beer off-premise license', 'shops'],
  P: ['package store permit', 'shops'], Q: ['wine-only package store permit', 'shops'], BP: ['brewpub license', 'food'], G: ['winery permit', 'food'],
};
const typeOf = (code: string) => TYPES[(code ?? '').trim().toUpperCase()] ?? [`${(code ?? '').trim()} alcohol permit`, 'food' as Cat];
const CANCELED = /cancel|surrender|expired|revok|suspend|inactive/i;
const DOMAIN = 'https://data.texas.gov';

async function soda(ctx: AdapterContext, dataset: string, where: string, order: string) {
  const u = new URL(`${DOMAIN}/resource/${dataset}.json`);
  u.searchParams.set('$where', where);
  u.searchParams.set('$order', order);
  u.searchParams.set('$limit', '2000');
  const r = await ctx.fetch(u, { headers: { accept: 'application/json', ...(process.env.SOCRATA_APP_TOKEN ? { 'X-App-Token': process.env.SOCRATA_APP_TOKEN } : {}) } });
  if (!r.ok) throw new Error(`data.texas.gov ${dataset}: HTTP ${r.status}`);
  return (await r.json()) as any[];
}
const addr = (x: any) => [x.address, x.address_2].filter(Boolean).join(' ').trim();

export function tabcApplications(city = 'DALLAS'): SourceAdapter {
  const a: SourceAdapter = {
    id: 'tabc_applications', family: 'alcohol', name: 'TABC pending applications',
    source: `${DOMAIN}/d/mxm5-tdpj`, license: 'Texas Open Data Portal public data',
    async fetch(ctx) {
      const rows = await soda(ctx, 'mxm5-tdpj', `upper(city)='${city}' AND submission_date > '${socrataTime(ctx.since)}'`, 'submission_date DESC');
      const out = [];
      for (const x of rows) {
        const [typeName, cat] = typeOf(x.license_type);
        const name = titleCase(x.trade_name || x.owner || 'Unnamed applicant');
        const street = addr(x);
        const point = street ? await ctx.geocode(`${x.address}, ${x.city}, TX ${x.zip ?? ''}`) : null;
        const status = String(x.applicationstatus ?? 'Received');
        out.push(observation(a, {
          recordId: `app:${x.applicationid}`,
          url: `${DOMAIN}/resource/mxm5-tdpj.json?applicationid=${encodeURIComponent(x.applicationid)}`,
          title: `TABC application ${x.applicationid} (${x.license_type})`,
          publishedAt: parseSocrata(x.submission_date) || ctx.now, observedAt: ctx.now,
          hashOf: [status, x.license_type, x.trade_name, street],
          facts: {
            name, address: titleCase(x.address ?? ''), suite: suiteOf(x.address_2, x.address), cat,
            geom: point ? { type: 'Point', coordinates: point } : null, stage: 'filed',
            statusText: `Alcohol permit application ${status.toLowerCase()}`,
            summary: `${name} applied to the Texas Alcoholic Beverage Commission for a ${typeName}. An application is not an approval.`,
            why: 'Alcohol permit applications often come before a new bar, restaurant or store opens.',
          },
        }));
      }
      return out;
    },
  };
  return a;
}

export function tabcLicenses(city = 'DALLAS'): SourceAdapter {
  const a: SourceAdapter = {
    id: 'tabc_licenses', family: 'alcohol', name: 'TABC license status',
    source: `${DOMAIN}/d/7hf9-qc9f`, license: 'Texas Open Data Portal public data',
    async fetch(ctx) {
      const t = socrataTime(ctx.since);
      const rows = await soda(ctx, '7hf9-qc9f', `upper(city)='${city}' AND (original_issue_date > '${t}' OR status_change_date > '${t}')`, 'status_change_date DESC');
      const out = [];
      for (const x of rows) {
        const [typeName, cat] = typeOf(x.license_type);
        const name = titleCase(x.trade_name || x.owner || 'Unnamed licensee');
        const status = String(x.primary_status ?? x.license_status ?? '');
        const canceled = CANCELED.test(status);
        const issued = parseSocrata(x.original_issue_date);
        const isNew = issued > ctx.since;
        const point = x.address ? await ctx.geocode(`${x.address}, ${x.city}, TX ${x.zip ?? ''}`) : null;
        out.push(observation(a, {
          recordId: `lic:${x.license_id}`,
          url: `${DOMAIN}/resource/7hf9-qc9f.json?license_id=${encodeURIComponent(x.license_id)}`,
          title: `TABC license ${x.license_type}-${x.license_id}`,
          publishedAt: (canceled ? parseSocrata(x.status_change_date) : issued) || ctx.now, observedAt: ctx.now,
          occurredAt: (canceled ? parseSocrata(x.status_change_date) : issued) || null,
          hashOf: [status, x.license_type, x.trade_name, addr(x)],
          facts: {
            name, address: titleCase(x.address ?? ''), suite: suiteOf(x.address_2, x.address), cat,
            geom: point ? { type: 'Point', coordinates: point } : null,
            stage: 'approved', canceled,
            statusText: canceled ? `Alcohol license ${status.toLowerCase()}` : isNew ? 'Alcohol license issued' : `Alcohol license ${status.toLowerCase()}`,
            summary: canceled
              ? `The ${typeName} for ${name} is now listed as ${status.toLowerCase()}. A license change does not by itself confirm the business closed.`
              : `The Texas Alcoholic Beverage Commission issued a ${typeName} to ${name}. A license is not an opening date.`,
            why: canceled ? 'Worth watching: the business may be changing hands, moving or closing.' : 'An issued license is usually one of the last steps before a bar or restaurant opens.',
          },
        }));
      }
      return out;
    },
  };
  return a;
}
