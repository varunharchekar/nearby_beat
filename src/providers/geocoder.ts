/** Geocoding providers. All results are checked against the coverage area by the caller. */
import type { Pt } from '../domain/types.ts';

export interface GeoResult {
  label: string;
  city: string;
  point: Pt;
  kind: 'address' | 'street' | 'intersection' | 'neighborhood' | 'place' | 'postcode';
  bbox?: [number, number, number, number];
  approx: boolean;
  /** Every place name around the match (neighborhood, locality, borough, city, county), when the provider knows them. */
  places?: string[];
}
export interface Geocoder {
  name: string;
  search(q: string, opts?: { proximity?: Pt; types?: GeoResult['kind'][]; limit?: number }): Promise<GeoResult[]>;
  /** Neighborhood containing or nearest to a point, if the provider knows neighborhoods. */
  neighborhood?(p: Pt): Promise<GeoResult | null>;
}

type Fetch = typeof fetch;

export class MapboxGeocoder implements Geocoder {
  name = 'mapbox';
  private token: string;
  private f: Fetch;
  constructor(token: string, f: Fetch = fetch) { this.token = token; this.f = f; }
  async search(q: string, opts: { proximity?: Pt; types?: GeoResult['kind'][]; limit?: number } = {}) {
    const u = new URL('https://api.mapbox.com/search/geocode/v6/forward');
    u.searchParams.set('q', q);
    u.searchParams.set('country', 'us');
    u.searchParams.set('limit', String(opts.limit ?? 5));
    u.searchParams.set('access_token', this.token);
    if (opts.proximity) u.searchParams.set('proximity', opts.proximity.join(','));
    const map: Record<string, string> = { address: 'address', street: 'street', neighborhood: 'neighborhood', place: 'place', postcode: 'postcode', intersection: 'street' };
    if (opts.types?.length) u.searchParams.set('types', [...new Set(opts.types.map((t) => map[t]))].join(','));
    const r = await this.f(u);
    if (!r.ok) throw new Error(`Mapbox geocoding failed: ${r.status}`);
    const j: any = await r.json();
    return (j.features ?? []).map((f: any): GeoResult => {
      const p = f.properties ?? {};
      // Mapbox returns intersections ("A St & B St") as street features with intersection accuracy.
      const kind = p.feature_type === 'street' && p.coordinates?.accuracy === 'intersection' ? 'intersection' : (p.feature_type ?? 'place');
      return {
        label: p.name_preferred ?? p.name ?? p.full_address,
        // Locality first: Brooklyn addresses are locality "Brooklyn" inside place "New York".
        city: [...new Set([p.context?.locality?.name, p.context?.place?.name])].filter(Boolean).concat([p.context?.region?.region_code, p.context?.postcode?.name].filter(Boolean)).join(', '),
        places: ['neighborhood', 'locality', 'place', 'district'].map((k) => p.context?.[k]?.name).filter(Boolean),
        point: [p.coordinates?.longitude ?? f.geometry.coordinates[0], p.coordinates?.latitude ?? f.geometry.coordinates[1]],
        kind: kind as GeoResult['kind'], bbox: p.bbox, approx: kind !== 'address',
      };
    });
  }
  async neighborhood(p: Pt): Promise<GeoResult | null> {
    const u = new URL('https://api.mapbox.com/search/geocode/v6/reverse');
    u.searchParams.set('longitude', String(p[0]));
    u.searchParams.set('latitude', String(p[1]));
    u.searchParams.set('types', 'neighborhood');
    u.searchParams.set('access_token', this.token);
    const r = await this.f(u);
    if (!r.ok) return null;
    const f: any = ((await r.json()) as any).features?.[0];
    return f ? { label: f.properties.name, city: f.properties.context?.place?.name ?? '', point: p, kind: 'neighborhood', bbox: f.properties.bbox, approx: true } : null;
  }
}

/** US Census geocoder: free, no key, addresses only. */
export class CensusGeocoder implements Geocoder {
  name = 'census';
  private f: Fetch;
  constructor(f: Fetch = fetch) { this.f = f; }
  async search(q: string) {
    const u = new URL('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress');
    u.searchParams.set('address', q);
    u.searchParams.set('benchmark', 'Public_AR_Current');
    u.searchParams.set('format', 'json');
    const r = await this.f(u);
    if (!r.ok) throw new Error(`Census geocoding failed: ${r.status}`);
    const j: any = await r.json();
    return (j.result?.addressMatches ?? []).map((m: any): GeoResult => ({
      label: m.matchedAddress.split(',')[0], city: m.matchedAddress.split(',').slice(1).join(',').trim(),
      point: [m.coordinates.x, m.coordinates.y], kind: 'address', approx: false,
    }));
  }
}

/** Fictional fixture geocoder used in fixture mode and tests. */
export class FixtureGeocoder implements Geocoder {
  name = 'fixture';
  private entries: (GeoResult & { keys: string })[];
  constructor(entries: GeoResult[]) { this.entries = entries.map((e) => ({ ...e, keys: `${e.label} ${e.city}`.toLowerCase() })); }
  async search(q: string, opts: { types?: GeoResult['kind'][] } = {}) {
    const stop = new Set(['ave', 'st', 'ln', 'and', 'tx', 'street', 'avenue', 'road', 'rd', 'lane', 'the', 'dallas']);
    const toks = q.toLowerCase().replace(/[&,]/g, ' ').split(/\s+/).filter((t) => t.length > 1 && !stop.has(t));
    const seen = new Set<string>();
    return this.entries.filter((e) => (!opts.types?.length || opts.types.includes(e.kind)) && toks.length > 0 && toks.every((t) => e.keys.includes(t)))
      .filter((e) => !seen.has(e.keys) && !!seen.add(e.keys))
      .map(({ keys, ...e }) => e);
  }
  async neighborhood(p: Pt) {
    const hoods = this.entries.filter((e) => e.kind === 'neighborhood' && e.bbox);
    const inside = hoods.find((h) => p[0] >= h.bbox![0] && p[0] <= h.bbox![2] && p[1] >= h.bbox![1] && p[1] <= h.bbox![3]);
    const near = inside ?? hoods.sort((a, b) => Math.hypot(a.point[0] - p[0], a.point[1] - p[1]) - Math.hypot(b.point[0] - p[0], b.point[1] - p[1]))[0];
    if (!near) return null;
    const { keys, ...rest } = near;
    return rest;
  }
}

/** Small in-process cache so repeated records do not re-geocode. */
export function cached(g: Geocoder, max = 5000): Geocoder {
  const m = new Map<string, Promise<GeoResult[]>>();
  return {
    name: g.name,
    neighborhood: g.neighborhood?.bind(g),
    search(q, opts) {
      const k = JSON.stringify([q.toLowerCase().trim(), opts ?? {}]);
      let v = m.get(k);
      if (!v) { v = g.search(q, opts).catch((e) => { m.delete(k); throw e; }); m.set(k, v); if (m.size > max) m.delete(m.keys().next().value!); }
      return v;
    },
  };
}
