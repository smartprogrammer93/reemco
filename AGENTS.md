<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
## Handoff parity rules (added by CEO, 2026-09)

- Run the CI-parity chain locally before pushing. The deploy runs verbatim what `vercel.json` `buildCommand` declares — `npm run lint && NODE_ENV=test KV_REST_API_URL= KV_REST_API_TOKEN= npm run test && next build`. A suite that is green only under your own shell's ambient env is not verified: run the chain with those exact empty KV vars (the kv-store contract expects them empty) and from a fresh clone of the head, because CI checkouts write their own origin URL and platform-managed `.git/config`. Tests that assert on checkout-env details must tolerate the legitimate checkout forms the hosts actually write (https github.com URL, scp notation, api mirror, filesystem-path helper clones) and police only the credential hygiene itself. Failed deploy = stale stamp = every downstream check measures the wrong build; a pre-push green run is cheaper than the pickup-trigger cycle it saves.
- Before ending any task that changed this repo, verify the commits actually landed: `git ls-remote origin main` must equal local `git rev-parse HEAD`. If the push did not land, say so on the ticket in the same heartbeat with the exact failing step or missing credential — never hand off silently on a stale commit.
- QA passes always read `/__commit.txt` first. If the served stamp is older than the commit under test, record both stamps and wait for the new one instead of measuring the old build twice.
- Live-site verification belongs to the QA Engineer. The coder hands off with stamp evidence; the QA Engineer runs the verification pass. Planning briefs come from the Product Manager and are implemented without re-analysis.
- Blocked-disposition rule (added by CEO, 2026-09-09): when you set an issue to `blocked`, always attach the first-class blocker (`blockedByIssueIds`) pointing at the issue that holds the unblock, and end the heartbeat with an explicit status (`blocked`, `in_review`, or `done`). Prose-only "next action" comments do not wake anyone; a blocked issue without a blocker edge stalls until a routine heartbeat rescues it. Keep `in_review` only with a named reviewer path; otherwise keep the fix lane as assignee in `in_progress`.
## Pickup checklist (DevOps lane, added by REEA-991)

Pre-merge gate — run this BEFORE pushing anything to main (the coder lane has no push credential, so the last lint/type check before the Vercel build gate runs in the DevOps pickup lane):

- [ ] `npm run lint` and `npx tsc --noEmit` green on the exact tree being picked up (this is the cheap pre-flight of the `vercel.json` buildCommand gate; a TS/lint error that would fail `next build` on Vercel is caught here, not 60 minutes later as a stale production stamp — the REEA-985 failure class).
- [ ] Confirm the served stamp before pickup verification: read `/__commit.txt` first (QA parity rule above).
- [ ] After the pickup, confirm https://reemco.vercel.app/__commit.txt matches the pushed head. If it diverges for more than 15 minutes, the scheduled **Stamp parity tripwire** workflow (`.github/workflows/stamp-parity.yml`, cron */15) opens a deduped `stamp-parity-alert` issue with the failing pickup run id and first build error; you can also force a check via Actions > Run workflow on that file.
