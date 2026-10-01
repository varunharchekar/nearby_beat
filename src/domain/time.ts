/**
 * Timezone-aware scheduling. All instants are UTC epoch milliseconds.
 * Issue keys use the subscriber's local Sunday date, so retries and DST changes never duplicate a send.
 */
export const DEFAULT_TZ = 'America/Chicago';
export const DAY = 86_400_000;
export const MIN = 60_000;
export const DISPATCH_HOUR = 9;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface LocalParts { y: number; m: number; d: number; h: number; mi: number; s: number; dow: number }
const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function localParts(utc: number, tz = DEFAULT_TZ): LocalParts {
  const o: Record<string, string> = {};
  for (const p of fmt(tz).formatToParts(new Date(utc))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second, dow: DOW[o.weekday] };
}

function offsetAt(utc: number, tz: string): number {
  const p = localParts(utc, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(utc / 1000) * 1000;
}

/** Convert a local wall-clock time to UTC. Day overflow (d = 0 or 32) is normalized. */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz = DEFAULT_TZ): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess - offsetAt(guess, tz);
  t = guess - offsetAt(t, tz);
  return t;
}

export function localDateKey(utc: number, tz = DEFAULT_TZ): string {
  const p = localParts(utc, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** Next Sunday at 9:00 local strictly after `after`. */
export function nextSunday(after: number, tz = DEFAULT_TZ): number {
  const p = localParts(after, tz);
  for (let add = 0; add <= 7; add++) {
    if ((p.dow + add) % 7 !== 0) continue;
    const t = zonedToUtc(p.y, p.m, p.d + add, DISPATCH_HOUR, 0, tz);
    if (t > after) return t;
  }
  return zonedToUtc(p.y, p.m, p.d + 7 + ((7 - p.dow) % 7), DISPATCH_HOUR, 0, tz);
}

/** Scheduling cutoff for a Sunday issue: Saturday 9:00 local. */
export function cutoffFor(sunday: number, tz = DEFAULT_TZ): number {
  const p = localParts(sunday, tz);
  return zonedToUtc(p.y, p.m, p.d - 1, DISPATCH_HOUR, 0, tz);
}

/** First Sunday an account verified at `t` can receive. Verification after the cutoff starts the following week. */
export function firstIssueAfter(t: number, tz = DEFAULT_TZ): number {
  let s = nextSunday(t, tz);
  if (t > cutoffFor(s, tz)) s = nextSunday(s, tz);
  return s;
}

export const isFifthSunday = (sunday: number, tz = DEFAULT_TZ) => localParts(sunday, tz).d > 28;

export function sundaysBetween(from: number, to: number, tz = DEFAULT_TZ): number[] {
  const out: number[] = [];
  let s = nextSunday(from - 1, tz);
  while (s < to) { out.push(s); s = nextSunday(s, tz); }
  return out;
}

export function tzAbbrev(utc: number, tz = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(new Date(utc)).find((p) => p.type === 'timeZoneName')?.value ?? '';
}

export function fmtDate(utc: number, tz = DEFAULT_TZ, opts: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric', ...opts }).format(new Date(utc));
}
export function fmtDateTime(utc: number, tz = DEFAULT_TZ): string {
  return `${fmtDate(utc, tz, { weekday: 'short' })}, ${new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(utc))} ${tzAbbrev(utc, tz)}`;
}
