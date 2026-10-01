# Nearby

A weekly email about meaningful physical changes near a subscriber's address: openings, closures, development and public works. Visitors pick an area, interests and research depth, read a real sample, refine it, and approve signup. The first three weekly issues are free; after that a monthly or annual plan continues delivery.

This repository is **Phase 2: the grounded Dallas pilot** from the PRD. The clickable Phase 1 prototype was a separate artifact.

## Status

| Phase | State |
|---|---|
| 1 · Reviewable prototype | Done (separate artifact) |
| 2 · Grounded Dallas pilot | **Built and tested in fixture mode.** Live mode needs the configuration below, and live source calls have not yet been run from a machine with internet access. |
| 3 · Paid launch | Billing code and webhooks are in place and tested with signed test events. Blocked on approved prices, Stripe keys, refund terms and billing disclosures. |

What "tested" means here: 55 automated tests (48 without a local Postgres) run the domain logic, the Postgres store (against a real Postgres 16), the adapters (on recorded-shape payloads), the services end to end, and the real HTTP server through the full journey. They do **not** cover: the PostGIS migration (`002_spatial.sql`), live calls to data.texas.gov / Legistar / Mapbox / Resend / Stripe, or rendering in real email clients. See [docs/requirements-checklist.md](docs/requirements-checklist.md).

## Quick start (fixture mode, no setup)

Requires Node 22.18 or later (runs TypeScript directly; no build step).

```sh
npm install
npm run dev          # http://localhost:3000, fictional fixtures, in-memory store
npm test
```

In fixture mode every place and record is fictional and clearly labeled. **Dev tools** (top right) let you move the clock forward week by week, run the scheduler, see the email outbox (including sign-in links), mark deliveries as bounced, send signed billing events, and sign in to the operator console.

Fixture addresses: `100 Sample Street`, `Main Street` (ambiguous), `Greenville Ave & Mockingbird`, `500 Example Road` (outside coverage).

## Live mode

```sh
cp .env.example .env      # fill in the values
docker compose up -d db   # PostgreSQL 16 + PostGIS
npm run migrate
npm run check:sources     # one call to each live source; prints what came back
npm start                 # web server + background worker
```

`/status` lists every source family with its availability and every feature still blocked by missing configuration. Production email and checkout stay off until their settings exist. Full checklist: [docs/provider-setup.md](docs/provider-setup.md).

## Sources (Dallas, checked October 2026)

| Family | Status | Source |
|---|---|---|
| Alcohol permit applications and licenses | Live adapter | TABC open data on data.texas.gov (`mxm5-tdpj`, `7hf9-qc9f`), daily |
| Zoning cases and amendments | Live adapter | Dallas City Council via Legistar Web API |
| Local reporting | Live adapter, needs feeds | RSS/Atom feeds you have permission to use (`RSS_FEEDS`) |
| Company announcements, public websites | Operator entry | Console form; same change detection and review |
| Building permits | **Unavailable** | Socrata dataset stopped Aug 2020; ArcGIS layer ends 2024; DallasNow (Accela) has no public API |
| Certificates of occupancy | **Unavailable** | No current open feed found |
| Business registrations, job postings, planning, ordinances, agendas | **Unavailable** | See [docs/coverage-inventory.md](docs/coverage-inventory.md) |

This is a real constraint on the product: "Balanced research" in Dallas currently adds only alcohol records, not permits. Users see this before they approve a sample.

## Architecture

```
src/
  domain/      pure logic: geometry, scheduling (DST-safe), preferences, parsing,
               change detection, evidence rules, eligibility, ledger, billing events, issue rendering
  adapters/    TABC, Legistar, RSS, fixtures; registry and coverage inventory
  providers/   geocoder (Mapbox / US Census / fixture), email (Resend / console), billing (Stripe / fake)
  store/       Store interface; in-memory and PostgreSQL implementations; migrations
  services/    onboarding + previews, accounts + billing, ingestion pipeline, weekly dispatch
  jobs/        job queue worker (Postgres SKIP LOCKED), scheduler tick, retries, dead-lettering
  server/      node:http server, routes, server-rendered pages, operator console, JSON API
public/        stylesheet and small progressive-enhancement script
db/migrations  001_core.sql (plain Postgres), 002_spatial.sql (PostGIS)
data/          fictional fixtures and fixture geocoder entries
test/          node:test suites
```

Pipeline: ingest → resolve entity → derive material changes → review (operator) → match area and preferences → build structured issue → validate citations → render HTML + text → recheck consent and entitlement → send → reconcile delivery events.

Key choices:
- **Only `pg` at runtime.** Mapbox, Resend and Stripe are called through their REST APIs with `fetch`.
- **Every page is a plain form**, so the whole journey works without JavaScript, a map or a mouse. `public/app.js` only adds pin moving and polygon drawing.
- **Area matching runs in application code** shared with the tests; PostGIS indexes change geometry for prefiltering.
- **Personal location data is encrypted** (AES-256-GCM) before it reaches the database, and never logged.
- **Review defaults to every change** in live mode (`REVIEW_MODE=all`). Set `REVIEW_MODE=flagged` to auto-approve clean records and only review conflicts, unlocated records and possible duplicates.
- **Credits count on final delivery** (`CREDIT_MODE=delivery`), once per account and Sunday key. `acceptance` mode counts on send and restores on hard bounce.

## Defaults chosen

- Scheduling cutoff: Saturday 9:00 am Central. Verification after that starts the following Sunday.
- Magic links: 15 minutes, single use, at most 3 per 10 minutes per address. Opening a link shows a button, so email link scanners can't use it up.
- Sample budget: 3 per draft, 5 per day per visitor; cached samples and failed attempts don't count.
- One story per business or project per issue. A reminder never appears alongside its own announcement.
- Conflicting dates from different sources hold both changes for review.
- Default coverage: the pilot area from Uptown to Lakewood (`COVERAGE_BBOX`).
- Checkout opens only after the third free issue (PRD MVP preference).

## Operations

```sh
npm run refresh      # refresh all sources now
npm run dispatch     # send any Sundays that have come due (idempotent)
```

The server runs the worker every 30 seconds (disable with `NO_WORKER=1` and run the CLI from cron instead). Logs are JSON lines with identifiers and counts only. Alerts are log events prefixed `alert.` (stale sources, dead jobs).
