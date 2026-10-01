import type { Config } from './config.ts';
import type { Store } from './store/types.ts';
import type { Geocoder } from './providers/geocoder.ts';
import type { Mailer } from './providers/email.ts';
import type { BillingProvider } from './providers/billing.ts';
import type { Registry } from './adapters/registry.ts';

export interface Clock { now(): number; offset: number }

export interface App {
  cfg: Config;
  store: Store;
  clock: Clock;
  geocoder: Geocoder;
  mailer: Mailer;
  billing: BillingProvider | null;
  registry: Registry;
  fetch: typeof fetch;
  log: (event: string, fields?: Record<string, string | number | boolean | null | undefined>) => void;
}

/**
 * Structured logs. Callers pass only identifiers and counts: never email addresses, home addresses,
 * coordinates or free-text geography (PRD section 13).
 */
export function makeLogger(quiet = false): App['log'] {
  return (event, fields = {}) => {
    if (quiet) return;
    process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
  };
}
