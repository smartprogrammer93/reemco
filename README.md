This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Git commit identity (required for all agents)

Every commit in this repo MUST use this git identity — Vercel blocks
deployments whose commit email cannot be matched to a GitHub account:

    git config user.name  "smartprogrammer93"
    git config user.email "smartprogrammer@windowslive.com"

Agents: set this locally before committing (or pass `-c user.name=... -c user.email=...`);
never commit with `@reemco.dev`, `.local`, or other non-GitHub emails.
If a Vercel deployment shows "Deployment Blocked — commit email could not be
matched to a GitHub account", the culprit is a commit with the wrong identity.

## Deploy

Canonical production host: **https://reemco.vercel.app** — Next.js server build on Vercel. Merge to `main` deploys automatically via `.github/workflows/deploy.yml`, no manual steps. Required repo Actions secret: `VERCEL_TOKEN` (+ optional `VERCEL_TEAM_ID` for `--scope`), injected as environment secrets only. Rollback: Actions > Deploy site > Run workflow with `rollback_sha` = previous known-good commit; the rollback run goes through the same verification steps. The post-deploy funnel smoke check (home → search → click-out) runs against reemco.vercel.app on every deploy. PRs are validated by `ci.yml` without deploying. The shared KV binding for the collect-job store (REEA-92) is ensured by the pipeline itself: the Attach KV step attaches the KV store to the `reemco` project before deploying when `KV_REST_API_URL` / `KV_REST_API_TOKEN` are missing from the project environment (REEA-143). Values come from the platform response at attach time — never committed.

### Vercel build gates & cron cadence (REEA-314)

`vercel.json` gates every Vercel build with lint + test and stamps
`public/__commit.txt` with the built SHA (REEA-243 parity check below). The
`crons` entry hits `/api/health` hourly as the funnel liveness check; on the
Hobby plan the cron tick lands once/day, and hourly cadence is carried by the
guarded GitHub-hosted smoke job instead, so monitoring never depends on paid
plans. Keep `vercel.json` to schema-approved keys only — Vercel validates it
with `additionalProperties: false`, so free-text notes belong here in the
README, not in the JSON file.

### Deploy parity check — after EVERY production deploy (REEA-296)

1. `curl -fsS https://reemco.vercel.app/__commit.txt` — prints the SHA the live artifact was stamped with at build time.
2. Compare with the intended HEAD: the run's `github.sha`, or `rollback_sha` on a rollback run. A failing run never promotes the alias, so the stamp equals the last green deploy's SHA until the next green run. Edge cache can hold an old stamp briefly (`age` header); retry after ~30 s before judging a mismatch real. Mechanics (REEA-366): the stamp is a static asset at the edge and the cache key ignores query strings, so `?v=…` busting does not bypass a stale HIT — read the `age` header instead; measured cycles flipped stamp + content within seconds of promotion, staleness beyond ~11 min (`age` ceiling) is a real mismatch.
3. Record both values in the deploy comment: `served=<sha> intended=<sha> match|no-match`. On no-match the new build is not live — treat the deploy as failed and rerun with `rollback_sha` = last known-good commit. QA (REEA-293) and Security (REEA-275) verification passes start only after this parity line exists.
4. Stamp-check pair (REEA-366): immediately after the alias flip, record stamp SHA + served-content fingerprint together — `curl -fsS https://reemco.vercel.app/ | grep -o '/_next/static/[^"]*' | head -3` (asset paths move with every build). Both move to the new artifact at the flip; when one leads the other, re-check after ~30 s and note the seconds between observations as the edge-cache lag window instead of filing a mismatch. Measured window and both verified pairs: see REEA-366.

The "Post-deploy artifact check" step in `.github/workflows/deploy.yml` runs the same comparison automatically and fails the job on mismatch; steps 1–4 are the human-side record for the deploy comment. Blast radius of a mismatch is one alias flip, verified against the stamped artifact.

## Funnel instrumentation (REEA-37)

Anonymous, cookie-free funnel events (`search_submitted`, `result_impressed`,
`item_clicked`, `zero_results`) POSTed to `/api/events` — server build only
(`npm run build && npm start`, or the production Vercel host reemco.vercel.app).
Static (`STATIC_EXPORT=1`) snapshots render the UI but have no API; beacons
there are silently dropped.

- Weekly report: `curl <deploy>/api/events/report?days=7` or `npm run report`
  (reads the local JSONL store in `EVENTS_DIR`, default `./.events`).
- Raw events are pruned after 90 days (Data Minimization); only aggregates outlive that.
- Hardening: JSON-only, 16 KB cap, batch ≤ 20, schema-validated fields, 120 req/min rate limit.
Deploy secrets: all four (SURGE_LOGIN, SURGE_TOKEN, VERCEL_TOKEN, VERCEL_TEAM_ID) are set in repo Actions secrets as of REEA-43. See issue REEA-43 for verification runs.

REEA-322 note: keep `vercel.json` limited to schema-approved keys (`additionalProperties: false` in Vercel's validator); a stray top-level `description` fails every build and freezes the alias at the last green artifact.

REEA-337 note: scheduled smoke check runs every 3h (`17 */3` / `47 */3` anchors, guard >=150min dedupe) to stay inside the Hobby Actions allowance; the tick also self-heals deploy parity (`__commit.txt` vs main HEAD, dispatches Deploy site on mismatch).

REEA-371 keep-warm: two complementary layers. (1) `vercel.json` `functions."src/app/**/route.ts".minInstances: 1` keeps one route-handler instance allocated as the quiet-hours floor. (2) `.github/workflows/keep-warm.yml` pings `GET /api/health` on step cron `2-59/5 * * * *` (every 5 min, off the :00 spike) plus once on each push to `main`, doubling as the funnel liveness check the Vercel cron carries. Measured envelope (04:20→05:45Z): arrivals inside the ~5 min fast-answer window answer ~2s; after longer idle the chain walks ~30-35s (REA-369 cache-first replay makes the immediate retry instant); the push-trigger ticks during active work plus the minInstances floor cover the quiet gaps. Scheduled ticks land hourly-ish and skip sometimes (REEA-71) and self-heal on the next step; push events proved the reliable trigger. Curl-only job (~8s/run; worst-case ceiling ~1,150 min/month, realistic ~150 with hourly-ish landing) plus smoke checks (~600) and push pairs stays inside the ~2,000 min/month Hobby Actions allowance. Rollback: revert the commit — removes the floor and the ping; alias serving is unaffected, smoke-check anchors remain as fallback heartbeat.
