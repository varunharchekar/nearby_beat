# Provider setup checklist

Configuration names only; never commit secrets. `/status` shows what is still missing.

## Database
- [ ] PostgreSQL 16 with PostGIS (`docker compose up -d db` locally, or a managed Postgres with the PostGIS extension).
- [ ] `DATABASE_URL`, then `npm run migrate`. `002_spatial.sql` needs PostGIS and has not been run in CI yet; run it once and report any error.
- [ ] `ADDRESS_ENCRYPTION_KEY` (`openssl rand -hex 32`). Losing it makes saved addresses unreadable; store it in your secret manager.
- [ ] `SESSION_SECRET` (32+ random characters).

## Geocoding and maps (Mapbox)
- [ ] Create a public token restricted to your domain: `MAPBOX_TOKEN`.
- [ ] Used for forward geocoding, neighborhood lookup and static basemap images. Without it the US Census geocoder handles street addresses only, and maps show the outline without streets.

## Email (Resend)
- [ ] Verify the sending domain; add SPF, DKIM and DMARC records.
- [ ] `RESEND_API_KEY`, `EMAIL_FROM`.
- [ ] Add a webhook to `https://<BASE_URL>/api/webhooks/email` for `email.sent`, `email.delivered`, `email.bounced`, `email.complained`, `email.failed`; set `RESEND_WEBHOOK_SECRET`.
- [ ] Send a test issue to Gmail, Outlook and Apple Mail (desktop and mobile) and check rendering and the one-click unsubscribe.

## Billing (Stripe) — Phase 3
- [ ] Decide prices, currency, tax handling, refund terms and billing disclosures (PRD §17).
- [ ] Create two recurring Prices (monthly, yearly): `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_ANNUAL`.
- [ ] `STRIPE_SECRET_KEY` (start with test mode).
- [ ] Webhook endpoint `https://<BASE_URL>/api/webhooks/billing` for `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`; set `STRIPE_WEBHOOK_SECRET`.
- [ ] Turn on the Customer Portal (card updates, invoices, plan switching).
- [ ] Run one full test-mode subscription: trial exhausted → checkout → webhook → paid issues → cancel at period end → term end.

## Sources
- [ ] `npm run check:sources` and confirm each adapter returns records.
- [ ] Optional `SOCRATA_APP_TOKEN` for data.texas.gov rate limits.
- [ ] `RSS_FEEDS` only for feeds you have permission to use; record the license text in each entry.

## Operations
- [ ] `OPERATOR_EMAILS` for console access.
- [ ] Choose `REVIEW_MODE` (`all` for launch is the default).
- [ ] Route `alert.*` log events to paging (stale sources, dead jobs, citation-check failures).
- [ ] Publish the privacy policy, retention rules and terms (placeholders at `/legal/*`).
