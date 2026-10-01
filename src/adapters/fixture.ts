/**
 * Fictional fixture sources for fixture mode. Records appear over time relative to an anchor
 * (first boot minus 30 days), so the dev clock can play weeks of changes forward.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Cat, Geom, Stage } from '../domain/types.ts';
import { DAY, fmtDate } from '../domain/time.ts';
import { observation } from './types.ts';
import type { SourceAdapter } from './types.ts';

interface FxRecord {
  f: string; rec: string; day: number; occurred?: number; name: string; address?: string; suite?: string; project?: string; cat: Cat; stage: Stage;
  status: string; summary: string; why: string; closed?: boolean; revision?: string; geom: Geom | null; title: string; url: string;
  opening?: { day: number; est: boolean; fmt: 'month' | 'season' | 'late-month' | 'day' };
  event?: { day: number; hour: number; kind: 'grand' | 'soft' };
}
const FILE = fileURLToPath(new URL('../../data/fixtures.json', import.meta.url));
let cache: FxRecord[] | null = null;
export const fixtureRecords = () => (cache ??= JSON.parse(readFileSync(FILE, 'utf8')).records as FxRecord[]);

let anchor = 0;
/** Set by the app at boot from persisted state. */
export function setFixtureAnchor(ms: number) { anchor = ms; }
export const fixtureAnchor = () => anchor;

function dateText(at: number, fmt: 'month' | 'season' | 'late-month' | 'day', tz = 'America/Chicago') {
  if (fmt === 'day') return fmtDate(at, tz, { weekday: 'short' });
  if (fmt === 'month') return fmtDate(at, tz, { month: 'short', day: undefined, year: 'numeric' });
  if (fmt === 'late-month') return `Late ${fmtDate(at, tz, { month: 'long', day: undefined, year: undefined })}`;
  const m = new Date(at).getUTCMonth();
  const season = m < 2 || m === 11 ? 'Winter' : m < 5 ? 'Spring' : m < 8 ? 'Summer' : 'Fall';
  return `${season} ${new Date(at).getUTCFullYear()}`;
}

export function fixtureAdapter(): SourceAdapter[] {
  const fams = [...new Set(fixtureRecords().map((r) => r.f))];
  return fams.map((family) => {
    const a: SourceAdapter = {
      id: `fixture_${family}`, family, name: `Fixture ${family.replace('_', ' ')}`, source: 'data/fixtures.json', license: 'Fictional test data',
      async fetch(ctx) {
        return fixtureRecords().filter((r) => r.f === family).map((r) => ({ r, at: anchor + r.day * DAY }))
          .filter(({ at }) => at > ctx.since && at <= ctx.now)
          .map(({ r, at }) => {
            const ev = r.event ? anchor + r.event.day * DAY + r.event.hour * 3600_000 : null;
            const op = r.opening ? anchor + r.opening.day * DAY : null;
            return observation(a, {
              recordId: r.rec, url: r.url, title: r.title, publishedAt: at, observedAt: at,
              occurredAt: r.occurred != null ? anchor + r.occurred * DAY : null,
              hashOf: [r.stage, r.status, r.summary, r.opening?.day, r.event?.day, r.revision],
              facts: {
                name: r.name, address: r.address, suite: r.suite, projectId: r.project, cat: r.cat, stage: r.stage, statusText: r.status,
                summary: r.summary, why: r.why, closed: r.closed, revision: r.revision, geom: r.geom,
                openingDate: op ? { text: dateText(op, r.opening!.fmt), est: r.opening!.est, at: op } : null,
                event: ev ? { at: ev, text: `${fmtDate(ev, 'America/Chicago', { weekday: 'short' })}${r.event!.kind === 'soft' ? ' (soft opening)' : ''}`, kind: r.event!.kind } : null,
              },
            });
          });
      },
    };
    return a;
  });
}
