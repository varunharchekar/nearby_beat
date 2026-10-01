/**
 * Local reporting through RSS/Atom feeds the operator has permission to use (RSS_FEEDS).
 * Only the headline, link and date are kept. Articles are linked, never reproduced.
 */
import type { Cat, Stage } from '../domain/types.ts';
import { extractAddress, observation } from './types.ts';
import type { SourceAdapter } from './types.ts';

const tag = (xml: string, t: string) => {
  const m = xml.match(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`, 'i'));
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim() : '';
};
const link = (xml: string) => tag(xml, 'link') || xml.match(/<link[^>]*href="([^"]+)"/i)?.[1] || '';

export function parseFeed(xml: string): { title: string; url: string; date: number; text: string }[] {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  return blocks.map((b) => ({
    title: tag(b, 'title'), url: link(b),
    date: Date.parse(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date')),
    text: `${tag(b, 'title')} ${tag(b, 'description') || tag(b, 'summary')}`,
  })).filter((x) => x.title && /^https?:\/\//.test(x.url));
}

const CHANGE = /\b(open(s|ed|ing)?|clos(e|es|ed|ing)|shutter|coming|plans?|construction|permit|develop|apartment|demolition|renovat|groundbreak|relocat|expan)\w*/i;
function classify(text: string): { cat: Cat; stage: Stage; closed: boolean } {
  const l = text.toLowerCase();
  const cat: Cat = /restaurant|bar\b|coffee|cafe|bakery|brewery|taco|pizza|kitchen|food hall/.test(l) ? 'food'
    : /gym|fitness|yoga|pilates|spa\b|wellness/.test(l) ? 'fitness'
    : /park|trail|sidewalk|bike lane|road|street work|transit|dart\b/.test(l) ? 'public'
    : /apartment|tower|hotel|office|development|demolition|mixed-use|condo/.test(l) ? 'dev' : 'shops';
  const closed = /\b(closed|closing|shutter|last day)\b/.test(l);
  const stage: Stage = closed ? 'closed' : /\b(now open|opened|opens today)\b/.test(l) ? 'open' : /construction|groundbreak/.test(l) ? 'construction' : 'announced';
  return { cat, stage, closed };
}

export function rssAdapter(feed: { name: string; url: string; license: string }): SourceAdapter {
  const id = `rss_${feed.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
  const a: SourceAdapter = {
    id, family: 'local_reporting', name: feed.name, source: feed.url, license: feed.license,
    async fetch(ctx) {
      const r = await ctx.fetch(feed.url, { headers: { accept: 'application/rss+xml, application/atom+xml, text/xml' } });
      if (!r.ok) throw new Error(`${feed.name}: HTTP ${r.status}`);
      const items = parseFeed(await r.text()).filter((i) => (i.date || ctx.now) > ctx.since && CHANGE.test(i.text));
      const out = [];
      for (const it of items) {
        const street = extractAddress(it.text);
        const point = street ? await ctx.geocode(`${street}, Dallas, TX`) : null;
        const k = classify(it.text);
        out.push(observation(a, {
          recordId: it.url, url: it.url, title: it.title, publishedAt: it.date || ctx.now, observedAt: ctx.now,
          hashOf: [it.title],
          facts: {
            name: it.title.length > 90 ? `${it.title.slice(0, 87)}…` : it.title, address: street ?? undefined, cat: k.cat,
            geom: point ? { type: 'Point', coordinates: point } : null, stage: k.stage, closed: k.closed,
            statusText: k.closed ? 'Reported closing' : k.stage === 'open' ? 'Reported open' : k.stage === 'construction' ? 'Reported under construction' : 'Reported',
            summary: `${feed.name} reported this. Read the full story at the source link.`,
            why: 'Reported by local media. An operator reviews each report before it is sent.',
          },
        }));
      }
      return out;
    },
  };
  return a;
}
