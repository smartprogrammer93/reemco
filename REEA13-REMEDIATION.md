# REEA-13 Remediation package (F1/F2/F3) — Security Engineer

Drop-in artifacts for the Reemco Next.js app (App Router). No source repo remote was
available to this agent at implementation time; these files are written to be copied
verbatim into the app repo, with regression tests that fail on the old (unvalidated)
code. Placement:

- `src/lib/safe-url.ts`        → F1 ingestion-time + render-time URL validator (shared helper)
- `src/lib/safe-url.test.ts`   → F1 regression tests (run with vitest/jest)
- `src/lib/offer-schema.ts`    → F3 ingestion schema (zod)
- `src/lib/offer-schema.test.ts`
- `middleware.ts` (repo root, or `src/middleware.ts`) → F2 CSP + hardening headers

Constraint from REEA-10/REEA-13: **F1 must land before the scraper pipeline goes live.**

## Integration steps for the owning engineer

1. Copy files, run tests: `npx vitest run src/lib` (or wire into existing jest config).
2. F1 ingestion: wrap every scraped offer/product/coupon URL with `sanitizeExternalUrl()`
   at the point where scraper output enters the data layer; reject (drop field or
   substitute `null`) rather than pass through.
3. F1 render: in every `<a href={...}>` render site for scraped data, use
   `safeHref()` — it returns a safe value or `null`; render the link only when non-null.
4. F2: deploy middleware with `CSP_MODE=report-only` first (default), watch reports,
   then set `CSP_MODE=enforce`. Nonce CSP works in dev/prod; with `output: "export"`
   static hosting, nonce headers come from middleware at serve time or edge host config —
   see note in `middleware.ts`.
5. F3: use `offerSchema.parse()` on every scraped record before persist.

## Residual risks / follow-ups
- Legitimate merchant redirector links are rejected by the scheme+userinfo allowlist;
  if needed later, add an internal `/r?url=` redirect endpoint with domain allowlist.
- CSP with static export (`output: "export"`) cannot inject per-request nonces from
  Next.js middleware on pure-static hosts; report-only + host-level headers are the
  interim control. Full nonce CSP requires the Vercel (server) deploy path.
- F4 (secrets/infra) remains owned by DevOps Engineer when infra exists.
