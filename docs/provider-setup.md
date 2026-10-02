# Running a live test on your Mac

About 15 minutes. Run every command from inside the `nearby_beat` folder.

## 1. Sign up (one time)

| Service | What it's for | Where | What to copy |
|---|---|---|---|
| **Anthropic API** (required) | The research | https://console.anthropic.com → sign up → **Billing**: add a card or credits (start with $10) → **API keys** → Create key | Key starting `sk-ant-` |
| **Mapbox** (strongly recommended) | Placing items on the map, intersections, neighborhood names, street basemap | https://account.mapbox.com/auth/signup → **Access tokens** | Default public token, starting `pk.` |
| **Docker Desktop** (recommended) | Database that survives restarts | https://www.docker.com/products/docker-desktop/ → install and open it | — |
| Resend (optional) | Emailing subscription confirmation links | https://resend.com/signup with the email you'll test with → **API Keys** | Key starting `re_` |

Without Mapbox, the free US Census geocoder places street addresses only. Items listed at intersections ("Greenville Ave & Belmont") get left out, so reports come out thinner.

## 2. Configure

```sh
git pull
npm install
cat > .env <<EOF
NEARBY_MODE=live
BASE_URL=http://localhost:3000
SESSION_SECRET=$(openssl rand -hex 32)
ADDRESS_ENCRYPTION_KEY=$(openssl rand -hex 32)
ANTHROPIC_API_KEY=<sk-ant-...>
MAPBOX_TOKEN=<pk....>
DATABASE_URL=postgres://nearby:nearby@localhost:5432/nearby
RESEND_API_KEY=<re_... or leave empty>
EMAIL_FROM=Nearby <onboarding@resend.dev>
OPERATOR_EMAILS=<your email>
DEV_TOOLS=true
EOF
```

Create `.env` once. Re-running the block makes a new encryption key, and saved data becomes unreadable.

## 3. Start

```sh
docker compose up -d db      # wait ~10 seconds the first time
npm run migrate              # Applied: 001_core.sql, 002_spatial.sql, 003_reports.sql
npm run research:check       # one small live research run, ~1–2 minutes, a few cents
npm start
```

`research:check` should end with `OK ... N items` and a few lines with real URLs. Paste me the output if it fails.

## 4. Use it

1. Open http://localhost:3000 and enter your address.
2. Pick interests, area and depth, then click **Run my report**. Wait 3 to 5 minutes; the page shows each search as it happens.
3. Read the report. Try **Make changes**, e.g. "Only food", then **Apply and research again**.
4. Try **Subscribe**. The confirmation link arrives by email (or in **Dev tools → Outbox** without Resend).
5. Open **Dev tools → Open the operator console → Reports** to see each run's searches, left-out items and estimated cost.

Limits while testing: 3 reports per search and 3 per day per visitor. Raise them in `.env` (`REPORTS_PER_DRAFT`, `REPORTS_PER_VISITOR_PER_DAY`) and restart.

## Starting over

```sh
docker compose down -v && docker compose up -d db && npm run migrate
```
