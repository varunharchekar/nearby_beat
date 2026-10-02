/** Research engine: stream parsing, pause_turn continuation, output parsing and validation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicResearcher, costOf, readStream } from '../src/research/anthropic.ts';
import { parseReport, userPrompt } from '../src/research/prompt.ts';
import { assemble } from '../src/research/assemble.ts';
import type { ResearchRequest, ResearchResult } from '../src/research/types.ts';
import { defaultPrefs } from '../src/domain/prefs.ts';
import { projector } from '../src/domain/geo.ts';
import type { Pt } from '../src/domain/types.ts';

const sse = (events: [string, unknown][]) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
const streamOf = (s: string, chunk = 37) => new ReadableStream<Uint8Array>({
  start(c) { const b = new TextEncoder().encode(s); for (let i = 0; i < b.length; i += chunk) c.enqueue(b.slice(i, i + chunk)); c.close(); },
});

const REPORT = { summary: 'Lots of restaurant churn on Greenville.', items: [
  { name: 'Corsaire', category: 'food', stage: 'construction', latest_update: 'October 2026', why_it_matters: 'Taking over Pizzeria Testa.', address: '3525 Greenville Ave, Dallas, TX', event: false, date_text: 'October 2026', date_is_estimate: true, evidence_type: 'news_report', sources: [{ url: 'https://news.example/corsaire', title: 'Corsaire coming', publisher: 'Example News', published: '2026-09-20' }] },
  { name: 'Bad category', category: 'nightlife', stage: 'open', latest_update: 'Open', why_it_matters: 'x', address: '1 Main St', evidence_type: 'other', sources: [{ url: 'https://x' }] },
] };

function turn(stop: string, opts: { query?: string; text?: string; withResults?: boolean } = {}) {
  const ev: [string, unknown][] = [['message_start', { message: { usage: { input_tokens: 1000, output_tokens: 1 } } }]];
  let i = 0;
  if (opts.query) {
    ev.push(['content_block_start', { index: i, content_block: { type: 'server_tool_use', id: `srv${i}`, name: 'web_search', input: {} } }]);
    ev.push(['content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: '{"query":' } }]);
    ev.push(['content_block_delta', { index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(opts.query) + '}' } }]);
    ev.push(['content_block_stop', { index: i }]);
    i++;
    ev.push(['content_block_start', { index: i, content_block: { type: 'web_search_tool_result', tool_use_id: 'srv0', content: [{ type: 'web_search_result', url: 'https://news.example/corsaire', title: 'Corsaire coming', encrypted_content: 'x', page_age: 'Sep 20, 2026' }] } }]);
    ev.push(['content_block_stop', { index: i }]);
    i++;
    ev.push(['content_block_start', { index: i, content_block: { type: 'web_fetch_tool_result', tool_use_id: 'srv1', content: { type: 'web_fetch_result', url: 'https://city.example/permit/1', content: { type: 'document', title: 'Permit 1' } } } }]);
    ev.push(['content_block_stop', { index: i }]);
    i++;
  }
  if (opts.text) {
    ev.push(['content_block_start', { index: i, content_block: { type: 'text', text: '' } }]);
    const t = opts.text;
    ev.push(['content_block_delta', { index: i, delta: { type: 'text_delta', text: t.slice(0, 40) } }]);
    ev.push(['content_block_delta', { index: i, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://cited.example/a', title: 'Cited', encrypted_index: 'e', cited_text: 'c' } } }]);
    ev.push(['content_block_delta', { index: i, delta: { type: 'text_delta', text: t.slice(40) } }]);
    ev.push(['content_block_stop', { index: i }]);
  }
  ev.push(['message_delta', { delta: { stop_reason: stop }, usage: { output_tokens: 500, server_tool_use: { web_search_requests: opts.query ? 1 : 0 } } }]);
  ev.push(['message_stop', {}]);
  return sse(ev);
}

test('stream parser assembles tool input, results, text and citations across chunk boundaries', async () => {
  const blocks: string[] = [];
  const m = await readStream(streamOf(turn('end_turn', { query: 'new restaurants Lower Greenville', text: 'Here is what I found, with a citation in the middle of it.' }), 13), (b) => blocks.push(b.type));
  assert.equal(m.stopReason, 'end_turn');
  assert.deepEqual(blocks, ['server_tool_use', 'web_search_tool_result', 'web_fetch_tool_result', 'text']);
  assert.deepEqual(m.content[0].input, { query: 'new restaurants Lower Greenville' });
  assert.equal(m.content[3].text, 'Here is what I found, with a citation in the middle of it.');
  assert.equal(m.content[3].citations[0].url, 'https://cited.example/a');
  assert.deepEqual(m.usage, { input: 1000, output: 500, searches: 1 });
});

test('researcher continues after pause_turn and returns seen URLs, progress and cost', async () => {
  const bodies: any[] = [];
  const responses = [turn('pause_turn', { query: 'Lower Greenville openings' }), turn('end_turn', { text: `Done.\n<report>${JSON.stringify(REPORT)}</report>` })];
  const fakeFetch = (async (_u: any, init: any) => { bodies.push(JSON.parse(init.body)); return new Response(streamOf(responses.shift()!), { status: 200 }); }) as typeof fetch;
  const r = new AnthropicResearcher({ apiKey: 'k', model: 'claude-sonnet-5-5', fetch: fakeFetch });
  const req: ResearchRequest = { areaName: 'Lower Greenville', city: 'Dallas, TX', center: [-96.77, 32.81], radiusMi: 1, includeNotes: [], excludeNotes: [], cats: ['food'], evAll: false, depth: 'bal', depthLabel: 'Balanced research', statusMin: '', maxItems: 10, lookbackDays: 60, today: '2026-10-02', maxSearches: 20, sources: 'all', maxFetches: 20, fetchMaxTokens: 20000, records: [{ id: 'c1', url: 'https://data.texas.gov/x', title: 'TABC', name: 'Sable', place: '1900 Greenville Ave', status: 'Filed', summary: 's', date: '2026-09-18', family: 'alcohol' }] };
  const seenQueries: number[] = [];
  const res = await r.run(req, (p) => seenQueries.push(p.queries.length), new AbortController().signal);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].tools[0].type, 'web_search_20250305');
  assert.equal(bodies[0].tools[0].max_uses, 20);
  assert.equal(bodies[0].stream, true);
  assert.equal(bodies[1].messages.length, 2, 'paused assistant turn sent back');
  assert.equal(bodies[1].messages[1].role, 'assistant');
  assert.equal(bodies[1].messages[1].content[0].type, 'server_tool_use');
  assert.ok(res.seenUrls.has('https://news.example/corsaire'));
  assert.ok(res.seenUrls.has('https://city.example/permit/1'));
  assert.ok(res.seenUrls.has('https://data.texas.gov/x'), 'official records count as seen');
  assert.equal(res.report.items.length, 1, 'invalid category dropped at parse');
  assert.equal(res.report.items[0].status, 'October 2026');
  assert.equal(res.report.items[0].sources[0].publisher, 'Example News');
  assert.ok(seenQueries.includes(1));
  assert.equal(res.usage.searches, 1);
  assert.equal(res.usage.inputTokens, 2000);
  assert.ok(Math.abs(res.usage.costUsd - costOf('claude-sonnet-5-5', { searches: 1, inputTokens: 2000, outputTokens: 1000 })) < 1e-9);
});

test('API errors are retried, then reported', async () => {
  let calls = 0;
  const f = (async () => { calls++; return new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401 }); }) as typeof fetch;
  const r = new AnthropicResearcher({ apiKey: 'k', model: 'm', fetch: f });
  await assert.rejects(r.run({ areaName: 'a', city: 'Dallas, TX', center: [0, 0], radiusMi: 1, includeNotes: [], excludeNotes: [], cats: ['food'], evAll: false, depth: 'ann', depthLabel: '', statusMin: '', maxItems: 1, lookbackDays: 60, today: '2026-10-02', maxSearches: 1, sources: 'articles', maxFetches: 1, fetchMaxTokens: 1000, records: [] }, () => {}, new AbortController().signal), /401: bad key/);
  assert.equal(calls, 1, '4xx is not retried');
});

test('prompt never includes the street address and carries the filters', () => {
  const p = userPrompt({ areaName: 'Lower Greenville', city: 'Dallas, TX', center: [-96.771234, 32.812345], radiusMi: 2, includeNotes: ['Knox Henderson'], excludeNotes: ['North of Mockingbird Ln'], cats: ['food', 'events'], evAll: false, depth: 'deep', depthLabel: 'Deep research', statusMin: 'approved:records', maxItems: 20, lookbackDays: 60, today: '2026-10-02', maxSearches: 30, sources: 'all', maxFetches: 30, fetchMaxTokens: 20000, records: [] });
  assert.ok(p.includes('32.812') && !p.includes('32.8123'), 'location rounded');
  assert.ok(p.includes('Exclude: North of Mockingbird Ln'));
  assert.ok(p.includes('zoning cases'));
  assert.ok(p.includes('only for the interests above'));
  assert.ok(p.includes('approved or further along'));
  assert.ok(p.includes('up to 30 web searches'));
});

test('parseReport tolerates fenced JSON and rejects junk', () => {
  assert.equal(parseReport('```json\n' + JSON.stringify(REPORT) + '\n```').items.length, 1);
  assert.throws(() => parseReport('no report here'), /readable report/);
});

test('assembly keeps only verified, located, in-area, matching items', async () => {
  const center: Pt = [-96.77, 32.81];
  const pr = projector(center);
  const near = pr.inv(400, 300), far = pr.inv(9000, 0);
  const prefs = { ...defaultPrefs(center, '100 Test St, Dallas, TX', 'Lower Greenville'), cats: ['food', 'events', 'dev'] as any };
  const item = (o: any) => ({ name: 'X', category: 'food', stage: 'announced', status: 'Upcoming', what: 'w', address: 'addr', evidence_type: 'news_report', sources: [{ url: 'https://seen.example/a' }], ...o });
  const raw: ResearchResult = {
    seenUrls: new Map([['https://seen.example/a', { title: 'Seen A' }], ['https://city.example/rec', { title: 'Record' }]]),
    usage: { searches: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 },
    report: { summary: 'S', coverage_notes: ['Note from research'], items: [
      item({ name: 'Kept news', address: 'near' }),
      item({ name: 'Grand opening', address: 'near', event: true, date_text: 'Sat, Oct 10' }),
      item({ name: 'Unverified', address: 'near', sources: [{ url: 'https://never-seen.example/x' }] }),
      item({ name: 'Far away', address: 'far' }),
      item({ name: 'Unplaceable', address: 'nowhere' }),
      item({ name: 'Shop', category: 'shops', address: 'near' }),
      item({ name: 'Permit', category: 'dev', stage: 'filed', evidence_type: 'official_record', address: 'near', sources: [{ url: 'https://city.example/rec/' }] }),
      item({ name: 'Kept news', address: 'near' }),
    ] },
  };
  const geo: Record<string, Pt> = { near, far };
  const out = await assemble(raw, prefs, { geocode: async (a) => geo[a] ?? null, from: 0, to: 1, tz: 'America/Chicago', fixture: false, limitations: [], recordUrls: new Set(['https://city.example/rec']), trustCoords: false });
  const names = out.issue.items.map((i) => i.name);
  assert.deepEqual(names, ['Grand opening', 'Kept news', 'Permit'], 'events first; duplicates merged');
  assert.deepEqual(Object.fromEntries(out.dropped.map((d) => [d.name, d.reason])), { Unverified: 'no source we could verify', 'Far away': 'outside your area', Unplaceable: 'location could not be confirmed', Shop: 'category not selected' });
  assert.equal(out.issue.items.find((i) => i.name === 'Permit')!.evidenceLabel, 'Primary record');
  assert.equal(out.issue.items[1].sources[0].publisher, 'seen.example');
  assert.ok(out.issue.limitations.some((l) => l.includes('Note from research')));
  assert.ok(out.issue.limitations.some((l) => l.includes("couldn't place")));
  const statusOut = await assemble(raw, { ...prefs, statusMin: 'approved:records' }, { geocode: async (a) => geo[a] ?? null, from: 0, to: 1, tz: 'America/Chicago', fixture: false, limitations: [], recordUrls: new Set(), trustCoords: false });
  assert.ok(!statusOut.issue.items.some((i) => i.name === 'Permit'), 'filing below status filter');
});

test('articles mode: government sites blocked, fewer and smaller page reads, article-only instructions', async () => {
  const bodies: any[] = [];
  const f = (async (_u: any, init: any) => { bodies.push(JSON.parse(init.body)); return new Response(streamOf(turn('end_turn', { text: `<report>${JSON.stringify(REPORT)}</report>` })), { status: 200 }); }) as typeof fetch;
  const r = new AnthropicResearcher({ apiKey: 'k', model: 'claude-haiku-4-5-20251001', fetch: f });
  await r.run({ areaName: 'Lower Greenville', city: 'Dallas, TX', center: [-96.77, 32.81], radiusMi: 1, includeNotes: [], excludeNotes: [], cats: ['food'], evAll: false, depth: 'bal', depthLabel: 'Standard', statusMin: '', maxItems: 10, lookbackDays: 60, today: '2026-10-02', maxSearches: 20, sources: 'articles', maxFetches: 5, fetchMaxTokens: 6000, records: [] }, () => {}, new AbortController().signal);
  const [search, fetchTool] = bodies[0].tools;
  assert.ok(search.blocked_domains.includes('dallascityhall.com') && search.blocked_domains.includes('legistar.com'));
  assert.equal(fetchTool.max_uses, 5);
  assert.equal(fetchTool.max_content_tokens, 6000);
  assert.ok(fetchTool.blocked_domains.includes('data.texas.gov'));
  assert.match(bodies[0].system, /Do not search or open government websites/);
  assert.match(bodies[0].messages[0].content, /up to 5 page reads/);
  assert.ok(!/zoning cases, council/.test(bodies[0].messages[0].content), 'no records depth guide');
});

test('model output is cleaned: citation tags removed, notes trimmed at sentence ends', async () => {
  const { cleanText, clip } = await import('../src/research/prompt.ts');
  assert.equal(cleanText('<cite index="51-1,51-2">Corsaire comes from East Dallas.</cite> <cite index="5">More.</cite>'), 'Corsaire comes from East Dallas. More.');
  assert.equal(clip('First sentence here. Second sentence that is quite long and goes on.', 30), 'First sentence here.');
  const r = parseReport(`<report>${JSON.stringify({ summary: '<cite index="1">S</cite>', items: [{ ...REPORT.items[0], why_it_matters: '<cite index="2">Why.</cite>' }], coverage_notes: ['a', 'b', 'c'] })}</report>`);
  assert.equal(r.items[0].what, 'Why.');
  assert.equal(r.summary, 'S');
  assert.equal(r.coverage_notes!.length, 2);
});

test('area is described by street and ZIP when no neighborhood is known', async () => {
  const { areaFromAddress } = await import('../src/services/reports.ts');
  assert.equal(areaFromAddress('2000 GREENVILLE AVE, DALLAS, TX, 75206'), 'Greenville Ave, ZIP 75206');
  assert.equal(areaFromAddress('Greenville Ave & Ross Ave, Dallas, TX 75206'), 'Greenville Ave & Ross Ave, ZIP 75206');
});

test('researcher asks the model to keep going when it stops early with searches left', async () => {
  const bodies: any[] = [];
  const one = { ...REPORT, items: [REPORT.items[0]] };
  const two = { ...REPORT, items: [{ ...REPORT.items[0], name: 'Second Cafe', address: '2000 Greenville Ave, Dallas, TX' }] };
  const responses = [
    turn('end_turn', { query: 'q1', text: `<report>${JSON.stringify(one)}</report>` }),
    turn('end_turn', { query: 'q2', text: `<report>${JSON.stringify(two)}</report>` }),
    turn('end_turn', { query: 'q3', text: `<report>${JSON.stringify(two)}</report>` }),
  ];
  const fakeFetch = (async (_u: any, init: any) => { bodies.push(JSON.parse(init.body)); return new Response(streamOf(responses.shift()!), { status: 200 }); }) as typeof fetch;
  const r = new AnthropicResearcher({ apiKey: 'k', model: 'claude-haiku-4-5-20251001', fetch: fakeFetch });
  const req: ResearchRequest = { areaName: 'Lower Greenville', city: 'Dallas, TX', center: [-96.77, 32.81], radiusMi: 1, includeNotes: [], excludeNotes: [], cats: ['food'], evAll: false, depth: 'bal', depthLabel: 'Standard', statusMin: '', maxItems: 20, minItems: 15, lookbackDays: 60, today: '2026-10-02', maxSearches: 20, sources: 'articles', maxFetches: 0, fetchMaxTokens: 1000, records: [] };
  const res = await r.run(req, () => {}, new AbortController().signal);
  assert.equal(bodies.length, 3, 'two nudges, then stop');
  assert.match(bodies[1].messages.at(-1).content, /using 1 of 20 searches/);
  assert.equal(bodies[1].tools[0].max_uses, 19, 'remaining search budget');
  assert.deepEqual(res.report.items.map((i) => i.name).sort(), ['Corsaire', 'Second Cafe'], 'earlier items kept even if the final list omits them');
  assert.equal(res.usage.searches, 3);
});
