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

Primary production path (self-hosted, REEA-1054): **https://ns539626.ip-144-217-72.net** — the dedicated box at `/opt/reemco`. Every push to `main` runs `.github/workflows/deploy-selfhosted.yml`: it ships the versioned compose/Caddy/scripts, builds the image from the exact pushed tree **on the box**, deploys the pinned commit tag, and verifies the public surface (stamp, four security headers, health) plus the funnel smoke suite. Required repo Actions secrets (environment injection only): `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KNOWN_HOSTS`. The public address lives in one repo variable, `PROD_BASE_URL`; flipping it to the production domain is the DNS-cutover action. Rollback: Actions > Deploy self-hosted > Run workflow with `rollback_sha` = previous known-good commit — the run redeploys the cached prior artifact (or rebuilds it from that exact commit if the cache was pruned) and passes the same verification gate.

Vercel is kept alive **only as the rollback path** until the board decides the DNS cutover and decommission: `.github/workflows/deploy.yml` is now manual-only and still deploys/rolls back https://reemco.vercel.app with `VERCEL_TOKEN`. `pickup.yml` is manual-only too (its push trigger was removed so a merge no longer produces two production deploys). `vercel.json` crons stay with Vercel and are inert once it stops taking traffic; the box's `reemco-health.timer` owns scheduled health checks. `keep-warm.yml` was deleted — the box has no serverless cold start.

Artifact decision (REEA-1054): **GHCR gets no credentials on the box; the box builds from `/opt/reemco/src`.** Tradeoff: no standing registry credential on production (Least Privilege) and rollback does not depend on a registry being reachable; the cost is that a deploy consumes box CPU and the npm registry, and the artifact is reproducible from the pinned tree + Dockerfile rather than being a CI-built digest. Blast radius: the build happens before the running container is touched; a failed build leaves the previous tag serving, and `deploy.sh` auto-rolls-back on a failed verify.

### Deploy parity check — after EVERY production deploy (REEA-296)

1. `curl -fsS $PROD_BASE_URL/__commit.txt` — prints the SHA the live artifact was stamped with.
2. Compare with the intended HEAD: the run's `github.sha`, or `rollback_sha` on a rollback run. `.github/workflows/deploy-selfhosted.yml` runs this comparison automatically and fails the job on mismatch.
3. Record both values in the deploy comment: `served=<sha> intended=<sha> match|no-match`. On no-match treat the deploy as failed and rerun with `rollback_sha` = last known-good commit. QA verification starts only after this parity line exists.
4. The on-box `verify.sh` runs the same stamp + header + health gate; its output is appended to `/var/log/reemco/deploy.log` on the box.

## Funnel instrumentation (REEA-37)

Anonymous, cookie-free funnel events (`search_submitted`, `result_impressed`,
`item_clicked`, `zero_results`) POSTed to `/api/events` — server build only
(`npm run build && npm start`, or the self-hosted production host at `PROD_BASE_URL`).
Static (`STATIC_EXPORT=1`) snapshots render the UI but have no API; beacons
there are silently dropped.

- Weekly report: `curl <deploy>/api/events/report?days=7` or `npm run report`
  (reads the local JSONL store in `EVENTS_DIR`, default `./.events`).
- Raw events are pruned after 90 days (Data Minimization); only aggregates outlive that.
- Hardening: JSON-only, 16 KB cap, batch ≤ 20, schema-validated fields, 120 req/min rate limit
  (REEA-826: enforced per serverless instance, not deployment-wide).
Deploy secrets: the self-hosted path uses `DEPLOY_SSH_KEY`/`DEPLOY_HOST`/`DEPLOY_USER`/`DEPLOY_KNOWN_HOSTS`; the Vercel rollback path still uses `VERCEL_TOKEN` (+ optional `VERCEL_TEAM_ID`). All are injected as environment secrets only — never committed or echoed.

REEA-322 note: keep `vercel.json` limited to schema-approved keys (`additionalProperties: false` in Vercel's validator); a stray top-level `description` fails every build and freezes the alias at the last green artifact.

REEA-337 note: scheduled smoke check runs every 3h (`17 */3` / `47 */3` anchors, guard >=150min dedupe) to stay inside the Hobby Actions allowance; the tick also self-heals deploy parity (`__commit.txt` vs main HEAD, dispatches **Deploy self-hosted** on mismatch).

REEA-371 keep-warm (**historical**): `.github/workflows/keep-warm.yml` pinged `GET /api/health` on a 5-minute cron plus once per push to `main` to keep the serverless alias warm. REEA-1054 deleted it: the self-hosted box runs a long-lived `next start`, so there is no cold-start penalty to pre-warm. The scheduled health tick now lives on the box (`reemco-health.timer`, 08:17/14:57 UTC), and the external uptime/smoke workflows own liveness alerting.

Self-host config note (REEA-1051): the crawler-facing canonical origin used by `/sitemap.xml`, `/robots.txt` and the outbound `ReemcoBot` UA comes from `REEMCO_SITE_ORIGIN`; `infra/compose.prod.yml` derives it from the one `REEMCO_SITE_ADDRESS` line in `/etc/reemco/release.env`, so the live box advertises itself rather than the Vercel rollback alias (unset falls back to the historical Vercel origin). `/api/health` now resolves its `build` stamp from `public/__commit.txt` on the self-hosted image, where `VERCEL_GIT_COMMIT_SHA` exists only at build time.
