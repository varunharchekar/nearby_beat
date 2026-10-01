/**
 * Adapter parsing tests with recorded-shape payloads (fields match the published dataset schemas).
 * Live endpoints are checked separately with `npm run check:sources` on a machine with internet access.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tabcApplications, tabcLicenses } from '../src/adapters/tabc.ts';
import { legistarZoning } from '../src/adapters/legistar.ts';
import { parseFeed, rssAdapter } from '../src/adapters/rss.ts';
import { extractAddress } from '../src/adapters/types.ts';
import type { AdapterContext } from '../src/adapters/types.ts';
import { deriveChanges } from '../src/domain/changes.ts';

function ctx(body: unknown, seen: string[], geocode: AdapterContext['geocode'] = async () => [-96.77, 32.81]): AdapterContext {
  return {
    now: Date.parse('2026-10-01T15:00:00Z'), since: Date.parse('2026-09-01T00:00:00Z'), geocode,
    fetch: (async (u: any) => { seen.push(String(u)); return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 }); }) as typeof fetch,
  };
}

test('TABC applications: query, facts and wording', async () => {
  const seen: string[] = [];
  const rows = [{ master_file_id: 1, applicationid: 990001, license_type: 'BG', applicationstatus: 'In Review', primary_license_id: null, submission_date: '2026-09-18T00:00:00.000', trade_name: 'SABLE & RYE WINE BAR', owner: 'SR HOSPITALITY LLC', address: '1900 GREENVILLE AVE', address_2: 'STE 210', city: 'DALLAS', state: 'TX', zip: '75206' }];
  const obs = await tabcApplications().fetch(ctx(rows, seen));
  const u = new URL(seen[0]);
  assert.equal(u.hostname, 'data.texas.gov');
  assert.equal(u.pathname, '/resource/mxm5-tdpj.json');
  assert.match(u.searchParams.get('$where')!, /upper\(city\)='DALLAS' AND submission_date > '2026-08-31T19:00:00'/);
  const o = obs[0];
  assert.equal(o.recordId, 'app:990001');
  assert.equal(o.facts.name, 'Sable & Rye Wine Bar');
  assert.equal(o.facts.suite, '210');
  assert.equal(o.facts.stage, 'filed');
  assert.equal(o.facts.cat, 'food');
  assert.match(o.facts.summary, /not an approval/);
  assert.equal(o.family, 'alcohol');
  assert.ok(o.url.startsWith('https://data.texas.gov/resource/mxm5-tdpj.json?applicationid=990001'));
});

test('TABC licenses: issuance vs cancellation never claims a closure', async () => {
  const seen: string[] = [];
  const rows = [
    { license_id: 5551, license_type: 'MB', primary_status: 'Active', original_issue_date: '2026-09-20T00:00:00.000', status_change_date: '2026-09-20T00:00:00.000', trade_name: 'LANTERN TORTILLA CO', address: '1800 BELMONT AVE', address_2: 'SUITE 120', city: 'DALLAS', zip: '75206' },
    { license_id: 4440, license_type: 'BG', primary_status: 'Cancelled', original_issue_date: '2019-02-01T00:00:00.000', status_change_date: '2026-09-27T00:00:00.000', trade_name: 'HOLLOW OAK BAR', address: '2000 GREENVILLE AVE', city: 'DALLAS', zip: '75206' },
  ];
  const [issued, canceled] = await tabcLicenses().fetch(ctx(rows, seen));
  assert.equal(issued.facts.statusText, 'Alcohol license issued');
  assert.match(issued.facts.summary, /not an opening date/);
  assert.equal(canceled.facts.canceled, true);
  assert.match(canceled.facts.summary, /does not by itself confirm the business closed/);
  const ch = deriveChanges(null, canceled, 'e1', () => 'c1');
  assert.equal(ch[0].type, 'cancellation');
});

test('Legistar zoning: filter, case number, address, amendment detection', async () => {
  const seen: string[] = [];
  const m = { MatterId: 22501, MatterGuid: 'ABC-123', MatterFile: '26-1001', MatterName: null, MatterTypeName: 'ZONING CASES - INDIVIDUAL', MatterStatusName: 'Under Advisement', MatterIntroDate: '2026-09-10T00:00:00', MatterLastModifiedUtc: '2026-09-15T12:00:00',
    MatterTitle: 'A public hearing to receive comments regarding an application for a Planned Development District on property zoned MF-2(A) on the northeast corner of Lovers Lane and Greenville Avenue, located at 5600 Greenville Avenue. Z256-123(JM)' };
  const [o] = await legistarZoning().fetch(ctx([m], seen));
  const u = new URL(seen[0]);
  assert.match(u.searchParams.get('$filter')!, /MatterLastModifiedUtc gt datetime'2026-09-01T00:00:00' and substringof\('ZONING', MatterTypeName\) eq true/);
  assert.equal(o.facts.name, 'Zoning case Z256-123(JM)');
  assert.equal(o.facts.address, '5600 Greenville Avenue');
  assert.equal(o.facts.stage, 'filed');
  assert.ok(o.url.includes('LegislationDetail.aspx?ID=22501&GUID=ABC-123'));
  const [o2] = await legistarZoning().fetch(ctx([{ ...m, MatterTitle: m.MatterTitle.replace('MF-2(A)', 'MF-2(A) with a maximum height of 4 stories') }], []));
  const ch = deriveChanges({ contentHash: o.contentHash, facts: o.facts }, o2, 'e', () => 'c');
  assert.equal(ch.length, 1);
  assert.match(ch[0].after!, /^Amended/);
  const [o3] = await legistarZoning().fetch(ctx([{ ...m, MatterStatusName: 'Approved' }], []));
  assert.equal(deriveChanges({ contentHash: o.contentHash, facts: o.facts }, o3, 'e', () => 'c')[0].after, 'Approved');
});

test('Unlocated records stay unlocated', async () => {
  const [o] = await legistarZoning().fetch(ctx([{ MatterId: 1, MatterGuid: 'g', MatterTitle: 'An ordinance amending zoning text', MatterStatusName: 'Filed', MatterIntroDate: '2026-09-10T00:00:00' }], [], async () => null));
  assert.equal(o.facts.geom, null);
  assert.equal(o.sourceStatus, 'unlocated');
});

test('RSS: parses RSS and Atom, keeps only change stories, links rather than copies', async () => {
  const rss = `<?xml version="1.0"?><rss><channel>
    <item><title><![CDATA[Fieldnote Coffee opens at 2100 Henderson Ave]]></title><link>https://news.example/fieldnote</link><pubDate>Mon, 28 Sep 2026 14:00:00 GMT</pubDate><description>Long article text that must not be copied.</description></item>
    <item><title>Council talks budget</title><link>https://news.example/budget</link><pubDate>Mon, 28 Sep 2026 14:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const obs = await rssAdapter({ name: 'Example News', url: 'https://news.example/feed', license: 'Headline and link use permitted' }).fetch(ctx(rss, []));
  assert.equal(obs.length, 1);
  assert.equal(obs[0].facts.address, '2100 Henderson Ave');
  assert.equal(obs[0].facts.stage, 'announced', '"opens" can mean a future date, so it is not treated as open');
  assert.ok(!JSON.stringify(obs[0]).includes('must not be copied'));
  const atom = parseFeed('<feed><entry><title>New tower planned</title><link href="https://x.example/a"/><updated>2026-09-20T10:00:00Z</updated><summary>s</summary></entry></feed>');
  assert.equal(atom[0].url, 'https://x.example/a');
});

test('address extraction', () => {
  assert.equal(extractAddress('located at 5600 Greenville Avenue. Z256'), '5600 Greenville Avenue');
  assert.equal(extractAddress('opens at 2100 N Henderson Ave next week'), '2100 N Henderson Ave');
  assert.equal(extractAddress('no address here'), null);
});
