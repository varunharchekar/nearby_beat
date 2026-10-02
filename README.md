# Nearby

Enter an address, pick a radius and what you care about, and Nearby researches what's changing around you: openings, closures, construction, development and public works. The research runs live for about 3 to 5 minutes and returns a report with a cited source on every item. If you like it, "Get this every week" saves your email and exact filters for a separate subscription service.

## How a report is made

```
address + filters
  → Claude with web search + web fetch over recent articles and business announcements,
    streaming progress to the page (government and records sites are blocked)
  → JSON report: business, address, latest update, why it matters, sources
  → validation: every cited URL must have been seen during the research,
    every address is geocoded and must fall inside your area (exclusions win),
    interests and status filters applied
  → report page: "Most relevant additions / updates" table, then by category
```

- **Privacy.** The research gets your neighborhood name and a location rounded to about 100 m, never your street address. Addresses are encrypted at rest; searches and reports are deleted after 24 hours.
- **Grounding.** Items whose sources weren't seen, that can't be placed on the map, or that fall outside the area are left out, and the report says how many and why ("Left out").
- **Sources.** By default (`RESEARCH_SOURCES=articles`) research uses only recent news, blogs and business announcements; government and permit sites are blocked at the search tool, page reads are capped (5 per report, 6,000 tokens each), and the Dallas record feeds are switched off. `RESEARCH_SOURCES=all` brings back official records and government sites.
- **Cost control.** Searches per report by depth (10 / 20 / 30), reports per search (3), per visitor per day (3) and a daily cap (100), all configurable. Failed or timed-out runs don't count. Unchanged settings reuse the last report for 6 hours.
- **Rough cost per report** with Claude Sonnet 5.5: about $0.50 to $1.50, mostly search results read as input tokens plus $0.01 per search. The operator console shows the actual estimate per report.

## Quick start (fixture mode)

Needs Node 22.18 or later. No keys needed: a simulated researcher works over fictional fixtures so you can see the whole flow.

```sh
npm install
npm run dev          # http://localhost:3000
npm test
```

Fixture addresses: `100 Sample Street`, `Main Street` (ambiguous), `Greenville Ave & Mockingbird`.

## Live mode

See [docs/provider-setup.md](docs/provider-setup.md) for the step-by-step. In short:

```sh
cp .env.example .env            # add ANTHROPIC_API_KEY, MAPBOX_TOKEN, secrets
docker compose up -d db         # Postgres + PostGIS (optional but recommended)
npm run migrate
npm run research:check          # one small live research call (a few cents)
npm start
```

## Subscription hand-off

The website doesn't run subscriptions or billing. When a visitor clicks **Subscribe** on a report:

1. We store a subscription request (email, consent, the report's exact filters) and email a single-use confirmation link.
2. On confirmation the request becomes `confirmed`. If `SUBSCRIBE_URL` is set, the visitor is redirected there with `?request=<signed token>`.
3. The subscription service reads the request with `GET /api/subscription-requests/:id` (header `Authorization: Bearer $SUBSCRIPTION_HANDOFF_SECRET`) and marks it with `POST /api/subscription-requests/:id/handed-off`.
4. Each week the subscription service asks for a new report with `POST /api/subscription-requests/:id/runs` (same header). By default it covers news since the previous run; the first run starts where the website report ended. Pass `{"since": "2026-10-01T00:00:00Z"}` to choose the start yourself. The response has a `poll` URL (`GET /api/subscription-reports/:reportId`, same header) that returns the finished report as JSON. Items sent in earlier issues are only repeated when there's a new update. Weekly runs don't count against website visitor limits.

Website reports cover news from the last `LOOKBACK_DAYS` days (default 90). Every item needs a source published inside the window.

`src/domain/ledger.ts` (trial credits and entitlements) and `src/domain/billing.ts` (Stripe event handling), with their tests, are kept from the earlier design for the subscription service to reuse. The website doesn't use them.

## Layout

```
src/
  research/   Claude researcher (streaming, pause_turn), prompt + output contract, fixture researcher, validation
  services/   onboarding (search, area editing, refinement), reports, official-record pipeline, operator sign-in
  domain/     geometry, preferences, parsing, change detection, issue rendering (+ ledger/billing for the subscription service)
  adapters/   official record feeds: TABC (data.texas.gov), Dallas zoning (Legistar), RSS; fixtures
  providers/  geocoder (Mapbox / US Census / fixture), email (Resend / console)
  store/      memory and Postgres stores, migrations
  server/     node:http server, pages, operator console, JSON API
```

## Operator console

`/ops` (sign in with an address in `OPERATOR_EMAILS`, or **Dev tools → Open the operator console** when `DEV_TOOLS=true`): reports with status, items, left-out count, searches, estimated cost and duration; subscription requests; official records (reject one to keep it out of reports); feed health; audit log.

## Known limits

- The research model can still misread a source. Every row links to its sources, and the report says so.
- Dallas has no open permit feed; permits only appear when the web research finds them.
- The live Claude API path is tested against recorded-shape streams, not yet against the real API from this build environment. Run `npm run research:check` first.
