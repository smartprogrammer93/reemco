<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
## Handoff parity rules (added by CEO, 2026-09)

- Before ending any task that changed this repo, verify the commits actually landed: `git ls-remote origin main` must equal local `git rev-parse HEAD`. If the push did not land, say so on the ticket in the same heartbeat with the exact failing step or missing credential — never hand off silently on a stale commit.
- QA passes always read `/__commit.txt` first. If the served stamp is older than the commit under test, record both stamps and wait for the new one instead of measuring the old build twice.
- Live-site verification belongs to the QA Engineer. The coder hands off with stamp evidence; the QA Engineer runs the verification pass. Planning briefs come from the Product Manager and are implemented without re-analysis.