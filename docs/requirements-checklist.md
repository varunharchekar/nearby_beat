# Requirements-to-test checklist

PRD §14 acceptance criteria, where each is implemented, and how it is verified. Run `npm test` (add `PGTEST_HOST=...` to also run the Postgres store and migration tests).

| # | Criterion | Where | Verified by | State |
|---|---|---|---|---|
| 1 | Confirm location, choose radius, interests, depth; grounded preview without login | `services/onboarding.ts`, `server/routes.ts` | `http.test.ts` journey; `flow.test.ts` | Passing (fixtures) |
| 2 | Zero categories blocks with inline error; selections survive navigation and refresh | `/start/interests`, draft stored server-side | `http.test.ts` (422 + persisted checkboxes) | Passing |
| 3 | Street corridors extend coverage; exclusions override; ambiguous streets need confirmation | `domain/geo.ts`, `domain/parse.ts`, `services/geo.ts` | `domain.test.ts` corridor/exclusion tests; `flow.test.ts` bare-street clarify | Passing |
| 4 | "Exclude north of a road" shows a proposed boundary, never silently applied | proposals in draft; Apply/Discard | `flow.test.ts`, `http.test.ts` (Continue blocked until confirmed) | Passing |
| 5 | Unavailable families disclosed before approval; selected families control eligibility | `adapters/registry.ts`, depth page, issue limitations | `http.test.ts` (ack required); `domain.test.ts` eligibility | Passing |
| 6 | Every item has evidence, location, dates and certainty label; no invented dates | `domain/issue.ts` `validateIssue` | `domain.test.ts` tampered-date test; `flow.test.ts` evidence checks | Passing (fixtures) |
| 7 | Refinement shows a diff, regenerates, invalidates old approval; approved version matches signup | `planRefinement`, signed plan tokens, `approvedPreview` | `flow.test.ts`, `http.test.ts` | Passing |
| 8 | Verification and consent before scheduling; unsupported location → separate waitlist | `services/accounts.ts`, `/start/waitlist` | `http.test.ts` | Passing (console mailer) |
| 9 | Sample uses no credit; three issues use exactly three credits across retries; failed sends none | `domain/ledger.ts`, `reconcileDelivery`, unique ledger key | `flow.test.ts`, `store.test.ts` (Postgres unique key) | Passing |
| 10 | Trial expiry pauses sends without charging; checkout uses configured prices and server-confirmed payment | `dispatchCheck`, `startCheckout`, webhook reducer | `flow.test.ts`, `http.test.ts` (redirect leaves "waiting") | Passing with fake billing; live Stripe untested |
| 11 | Both plans deliver every Sunday including fifth; annual lasts its term | `paidCovers`, `sundaysBetween` | `domain.test.ts` (Nov 2026 fifth Sunday, 53-Sunday year), `flow.test.ts` paid Sundays | Passing |
| 12 | Duplicate and out-of-order webhooks are safe | `domain/billing.ts` | `domain.test.ts`, `flow.test.ts` | Passing |
| 13 | Unchanged project not repeated; material date change shows before and after | `domain/changes.ts` | `domain.test.ts`; fixture Pinecrest delay | Passing |
| 14 | Quiet week sends honest short issue; outage sends non-credit notice | `buildIssue` quiet kind, `broadOutage` | `domain.test.ts` quiet; `flow.test.ts` outage | Passing |
| 15 | Unsubscribe suppresses queued sends; cancellation keeps term; both explained | `dispatchCheck` at send time, `/u/:token`, account page | `flow.test.ts`, `http.test.ts` | Passing |
| 16 | One account can't read another's address, draft, preview, archive or billing | session + ownership checks; draft token hashing | `http.test.ts` (other visitor redirected; wrong draft token 404) | Passing |
| 17 | Conflicts go to review or are described; job postings alone aren't confirmed openings | `detectConflict`, `conflictingWith`, `evidenceLabel` | `domain.test.ts`, `flow.test.ts` | Passing |
| 18 | Mobile onboarding and email rendering; forms usable without map or mouse | server-rendered forms, responsive CSS, plain-text email | Headless browser screenshots during build; `http.test.ts` uses forms only | Partial: real email-client rendering not tested |

## Fixtures covered (PRD §14)

Boundary points, road crossings (line partly in area), late evidence (Pecan Street Deli), amended documents (zoning revision), daylight-saving transitions (Nov 1, 2026), hard bounces, account edits, fifth-Sunday months.

## Not covered by automated tests

- `db/migrations/002_spatial.sql` (needs PostGIS).
- Live source endpoints (`npm run check:sources`).
- Mapbox, Resend and Stripe live APIs (code follows their documented REST APIs and signature schemes).
- Email rendering in real clients.
