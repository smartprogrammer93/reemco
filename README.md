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

Canonical production host: **https://reemco.vercel.app** — Next.js server build on Vercel. Merge to `main` deploys automatically via `.github/workflows/deploy.yml`, no manual steps. Required repo Actions secret: `VERCEL_TOKEN` (+ optional `VERCEL_TEAM_ID` for `--scope`), injected as environment secrets only. Rollback: Actions > Deploy site > Run workflow with `rollback_sha` = previous known-good commit; the rollback run goes through the same verification steps. The post-deploy funnel smoke check (home → search → click-out) runs against reemco.vercel.app on every deploy. PRs are validated by `ci.yml` without deploying.

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
