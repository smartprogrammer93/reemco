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

## Git commit identity (required for all agents)

Every commit in this repo MUST use this git identity so GitHub attributes it
to a real account (and so the Actions checkout/build records stay consistent):

    git config user.name  "smartprogrammer93"
    git config user.email "smartprogrammer@windowslive.com"

Agents: set this locally before committing (or pass `-c user.name=... -c user.email=...`);
never commit with `@reemco.dev`, `.local`, or other non-GitHub emails.

## Deploy

Production path (self-hosted, REEA-1054): **https://ns539626.ip-144-217-72.net** — the dedicated box at `/opt/reemco`. Every push to `main` runs `.github/workflows/deploy-selfhosted.yml`: it ships the versioned compose/Caddy/scripts, builds the image from the exact pushed tree **on the box**, deploys the pinned commit tag, and verifies the public surface (stamp, four security headers, health) plus the funnel smoke suite. Required repo Actions secrets (environment injection only): `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_KNOWN_HOSTS`. The public address lives in one repo variable, `PROD_BASE_URL`. Rollback: Actions > Deploy self-hosted > Run workflow with `rollback_sha` = previous known-good commit — the run redeploys the cached prior artifact (or rebuilds it from that exact commit if the cache was pruned) and passes the same verification gate.

This is the **only** deploy path. Vercel was decommissioned in REEA-1076: the board confirmed `ns539626.ip-144-217-72.net` as production and `reemco.vercel.app` returned **402 `DEPLOYMENT_DISABLED`**, so it was no longer a usable rollback. `.github/workflows/deploy.yml`, `pickup.yml`, `vercel.json`, the `deploy:prod` npm script and the `VERCEL_TOKEN`/`VERCEL_TEAM_ID` repo secrets are gone. Scheduled health checks are owned by the box (`reemco-health.timer`, 08:17/14:57 UTC); `keep-warm.yml` was deleted earlier — the box has no serverless cold start. The `process.env.VERCEL` / `AWS_LAMBDA_FUNCTION_NAME` branches in the app are intentional fallbacks and stay (they are inert on the box, which sets `NODE_ENV=production` and no serverless vars).

### Deploy gate — lint + full test suite (REEA-1067)

Every push to `main` runs `npm run lint` and `NODE_ENV=test KV_REST_API_URL= KV_REST_API_TOKEN= npm run test` in `.github/workflows/deploy-selfhosted.yml` **before** any SSH or on-box build — the same two commands the retired `vercel.json` `buildCommand` used to run. Blast radius: a red gate fails on the GitHub runner and never touches the box, so there is nothing to roll back. Rollback Path: unchanged (`deploy.sh`/`rollback.sh`, auto-rollback on a failed verify); a `workflow_dispatch` rollback run deliberately skips lint/tests because it redeploys a previously verified artifact, and an emergency rollback must not be blocked by a gate that is red on main.

The gate is CI-side, not in `infra/Dockerfile`: the box's CPU is production capacity and the Dockerfile stays build-only, and `.dockerignore` excludes `.github` while `src/ci-secrets.test.ts` reads `.github/workflows/deploy.yml` — an in-image suite would need a widened build context to mean anything. `src/deploy-gate.test.ts` pins the gate in place. The manual on-box build fallback (see Gotchas) bypasses CI and is therefore emergency-only: run the gate commands by hand before using it.

Artifact decision (REEA-1054): **GHCR gets no credentials on the box; the box builds from `/opt/reemco/src`.** Tradeoff: no standing registry credential on production (Least Privilege) and rollback does not depend on a registry being reachable; the cost is that a deploy consumes box CPU and the npm registry, and the artifact is reproducible from the pinned tree + Dockerfile rather than being a CI-built digest. Blast radius: the build happens before the running container is touched; a failed build leaves the previous tag serving, and `deploy.sh` auto-rolls-back on a failed verify.

### Deploy parity check — after EVERY production deploy (REEA-296)

1. `curl -fsS $PROD_BASE_URL/__commit.txt` — prints the SHA the live artifact was stamped with.
2. Compare with the intended HEAD: the run's `github.sha`, or `rollback_sha` on a rollback run. `.github/workflows/deploy-selfhosted.yml` runs this comparison automatically and fails the job on mismatch.
3. Record both values in the deploy comment: `served=<sha> intended=<sha> match|no-match`. On no-match treat the deploy as failed and rerun with `rollback_sha` = last known-good commit. QA verification starts only after this parity line exists.
4. The on-box `verify.sh` runs the same stamp + header + health gate; its output is appended to `/var/log/reemco/deploy.log` on the box.
5. **Invariant (REEA-1233): maximum acceptable lag between `origin/main` and the served `/__commit.txt` is 15 minutes.** Beyond that, or when the deploy run for the head failed/cancelled (the lag is final, not in flight), the scheduled `stamp-parity.yml` tripwire opens/appends the deduped `stamp-parity-alert` issue naming the failing run; production keeps serving the last good artifact until a green deploy catches up. Read the state yourself with `npm run parity` (`scripts/parity-check.mjs`): it prints `PARITY: served=… origin/main=… lag_min=… status=…` and exits 1 when behind beyond the window. The deploy workflow writes the same line into its job summary (advisory there: a push landing mid-run is a queued deploy, not a stale artifact).

### Egress reputation — expected lane state (REEA-1067)

**Decision (2026-11-22, DevOps): accept the current egress `144.217.72.236` with honest per-lane expected state; no cleaner/allowlisted egress this cycle.** Rationale: the large majority of live lanes answer from this egress; the three that do not fail on Cloudflare IP reputation, not on adapter code (all three adapters are unchanged from the Vercel deployment where they worked). Adding a forward proxy/allowlisted egress is a new runtime dependency with its own blast radius (proxy down = every lane down) and latency, and there is no evidence yet that a single proxy clears all three zones. Revisit trigger: if the cutover target is a different provider/region, re-probe before the DNS flip; the same probe decides Ounass re-admission.

Per-lane expected state from the box (re-probed 2026-11-22T23:39Z, 6 EN+AR samples via `scripts/reea1051-adapter-probe.mjs`; `/api/echo` confirms the zone status):

| Lane | Expected state from this egress | Note the app records | Action |
|---|---|---|---|
| Xcite, Jarir, Eureka, Sultan Center, Blink, Quadra, Switch, Wibi, Zayoom, Astore, Aster, Nahdi, Alghanim, Danube Home, Nest, Bomai, Hobby Center, YasO, Yousifi | live offers | — | none |
| Amazon.eg | partial; intermittent HTTP 503 apology pages | honest `HTTP 503` note | keep |
| BinSina | intermittent timeout | honest timeout note | keep |
| Shopify lanes (Blink, Quadra, Switch, Wibi, Astore, Zayoom) | live; transient HTTP 429 bursts when several lanes fire at once | honest `HTTP 429` note | keep; no adapter change |
| **Next Store** | **0 hits, expected** — Cloudflare managed challenge (`HTTP 403`, `rotation_fail`) from this egress | honest `HTTP 403` note | **keep** (worked on Vercel; adapter unchanged; `zones.nextstore.com.kw` in `/api/echo` is the tripwire) |
| **Lulu Hypermarket** | **0 hits, expected** — Cloudflare block (`HTTP 403`, `rotation_fail`, ~4.5 KB block page); the note is a silent zero | `/api/echo` `zones.luluhypermarket.com` = `rotation_fail`; the zero-hit note is truthful but does not carry the reason (the echo cell does) | **keep** (worked on Vercel; adapter unchanged) |
| **Ounass** | **retired from the live rotation** — 0 hits on every sample from this egress ("fetch failed") and on a second egress (Cloudflare "Just a moment") | lane absent | **retired** (parser + test kept; restore path documented at the COLLECTORS list in `live-search.ts`) |

Re-probe after any egress change:

```sh
node scripts/reea1051-adapter-probe.mjs https://ns539626.ip-144-217-72.net
jq -r '.samples[] | .query as $q | .notes[] | select(.merchant|test("Next Store|Lulu|Ounass")) | "\($q) | \(.merchant) | hits=\(.hits) | err=\(.error)"' reea1051-adapter-probe.json
```

Do not retire Next Store or Lulu on this evidence alone: both are egress-reputation regressions against adapters that are unchanged and were verified on Vercel. Ounass was the only lane that failed on two egresses.

## Funnel instrumentation (REEA-37)

Anonymous, cookie-free funnel events (`search_submitted`, `result_impressed`,
`item_clicked`, `zero_results`) POSTed to `/api/events` — server build only
(`npm run build && npm start`, or the self-hosted production host at `PROD_BASE_URL`).
Static (`STATIC_EXPORT=1`) snapshots render the UI but have no API; beacons
there are silently dropped.

- Weekly report: `curl <deploy>/api/events/report?days=7` or `npm run report`
  (reads the local JSONL store in `EVENTS_DIR`, default `./.events`). The
  endpoint carries a 30 req/min per-caller budget (REEA-1251) and serves a
  30 s in-process aggregate cache, so a repeat read does not re-read and
  re-parse the event blob.
- Raw events are pruned after 90 days (Data Minimization); only aggregates outlive that.
- Hardening: JSON-only, 16 KB cap, batch ≤ 20, schema-validated fields, 120 req/min rate limit
  (REEA-826: enforced per serverless instance, not deployment-wide).
Deploy secrets: the self-hosted path uses `DEPLOY_SSH_KEY`/`DEPLOY_HOST`/`DEPLOY_USER`/`DEPLOY_KNOWN_HOSTS`. All are injected as environment secrets only — never committed or echoed. There is no Vercel credential any more (REEA-1076).

REEA-337 note: scheduled smoke check runs every 3h (`17 */3` / `47 */3` anchors, guard >=150min dedupe) to stay inside the Hobby Actions allowance; the tick also self-heals deploy parity (`__commit.txt` vs main HEAD, dispatches **Deploy self-hosted** on mismatch).

REEA-371 keep-warm (**historical**): `.github/workflows/keep-warm.yml` pinged `GET /api/health` on a 5-minute cron plus once per push to `main` to keep the serverless alias warm. REEA-1054 deleted it: the self-hosted box runs a long-lived `next start`, so there is no cold-start penalty to pre-warm. The scheduled health tick now lives on the box (`reemco-health.timer`, 08:17/14:57 UTC), and the external uptime/smoke workflows own liveness alerting.

Self-host config note (REEA-1051): the crawler-facing canonical origin used by `/sitemap.xml`, `/robots.txt` and the outbound `ReemcoBot` UA comes from `REEMCO_SITE_ORIGIN`; `infra/compose.prod.yml` derives it from the one `REEMCO_SITE_ADDRESS` line in `/etc/reemco/release.env`, so the live box advertises itself. Since REEA-1076 the compiled-in fallback (env unset) is also the production host, `https://ns539626.ip-144-217-72.net`, not the retired Vercel alias. `/api/health` resolves its `build` stamp from `public/__commit.txt` on the self-hosted image, where `VERCEL_GIT_COMMIT_SHA` exists only at build time (set by `infra/Dockerfile` from `REEMCO_COMMIT`).
