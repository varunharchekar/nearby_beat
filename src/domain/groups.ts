/** Display groups for the report: finer than interests, each with an icon. Order is report priority. */
export interface Group { id: string; name: string; icon: string; color: string }

export const GROUPS: Group[] = [
  { id: 'restaurants', name: 'Restaurants', icon: '🍽️', color: '#C2410C' },
  { id: 'bars', name: 'Bars and nightlife', icon: '🍸', color: '#7C3AED' },
  { id: 'cafes', name: 'Coffee and sweets', icon: '☕', color: '#92400E' },
  { id: 'shops', name: 'Shopping and services', icon: '🛍️', color: '#BE185D' },
  { id: 'wellness', name: 'Fitness and wellness', icon: '🧘', color: '#0F766E' },
  { id: 'events', name: 'Openings and events', icon: '🎉', color: '#B45309' },
  { id: 'public', name: 'Public spaces and infrastructure', icon: '🌳', color: '#15803D' },
  { id: 'dev', name: 'Buildings and development', icon: '🏗️', color: '#475569' },
  { id: 'offices', name: 'Offices', icon: '🏢', color: '#64748B' },
];
const byId = Object.fromEntries(GROUPS.map((g) => [g.id, g])) as Record<string, Group>;

const BAR_NAME = /\b(bar|pub|brewery|brewpub|brewing|taproom|tap room|tavern|lounge|cocktails?|speakeasy|saloon|nightclub|club|beer garden|icehouse|wine|cantina|biergarten)\b/i;
const CAFE_NAME = /\b(coffee|caf[eé]|espresso|bakery|bakehouse|bakeshop|donuts?|doughnuts?|desserts?|ice cream|gelato|creamery|tea|boba|pastr(y|ies)|cookies?|cupcakes?|kolaches?|juice|smoothie)\b/i;
const BAR_TEXT = /\b(cocktail bar|wine bar|sports bar|dive bar|rooftop bar|brewery|taproom|brewpub|speakeasy|nightclub|beer garden|lounge)\b/i;
const OFFICE = /\boffices?\b|office (building|tower|space|campus)/i;

export function groupOf(it: { cat: string; name: string; summary?: string; venue?: string | null }): Group {
  const text = `${it.name} ${it.summary ?? ''}`;
  switch (it.cat) {
    case 'food': {
      const v = (it.venue ?? '').toLowerCase();
      if (v === 'bar') return byId.bars;
      if (v === 'cafe') return byId.cafes;
      if (v === 'restaurant') return byId.restaurants;
      if (BAR_NAME.test(it.name)) return byId.bars;
      if (CAFE_NAME.test(it.name)) return byId.cafes;
      if (BAR_TEXT.test(it.summary ?? '')) return byId.bars;
      return byId.restaurants;
    }
    case 'shops': return byId.shops;
    case 'fitness': return byId.wellness;
    case 'events': return byId.events;
    case 'public': return byId.public;
    case 'dev': return OFFICE.test(text) ? byId.offices : byId.dev;
    default: return byId.shops;
  }
}

/** Shared web/PDF layout: top five first, then the rest by group, numbered continuously. */
export function reportSections<T extends { cat: string; name: string; summary?: string; venue?: string | null }>(items: T[]) {
  const top = items.slice(0, Math.min(5, items.length));
  const rest = items.slice(top.length);
  let n = top.length + 1;
  const groups = GROUPS.map((g) => ({ group: g, items: rest.filter((x) => groupOf(x).id === g.id) })).filter((x) => x.items.length)
    .map((x) => { const s = { ...x, startAt: n }; n += x.items.length; return s; });
  return { top, groups };
}
