# REEA-93 — jarir.com / amazon.eg live-collection fix (Fullstack Coder)

## Symptom (QA)
jarir.com and amazon.eg retailer subtasks ended `failed` during real-time
collection (`POST /api/products/:id/collect`), so results pages lost two of
their three live offers.

## Fix 1 — retailer-search fallback adapters (already in place)
`scrapeOffer` (`src/lib/collect/scraper.ts`) tries the direct offer URL, then
re-discovers the product via the retailer's own search API
(`src/lib/collect/search-fallback.ts`):

- **jarir.com** — Nuxt SSR homepage carries the Constructor.io index key
  (`searchProviderKeys` anchor in `__NUXT_DATA__`, EN key = last literal);
  query `ac.cnstrc.com/search` directly and rank hits by title-token F-score.
- **amazon.eg** — no JSON contract; parse the `/s?k=` results HTML: cards via
  `data-component-type="s-search-result"`, ASIN from the `/dp/` path, price
  from `a-offscreen` (Arabic-Indic digits normalized), stock via the Arabic
  `غير متوفر` marker; rank mixed Arabic/Latin titles by token coverage with
  Amazon's own result order as tie-break.

## Fix 2 — root cause of the amazon.eg subtask failure (this change)
The seeded `Amazon.eg (ships to KW)` offers carried **`www.bing.com/search`
redirector URLs**. `domainOf()` derives the dispatch key from the offer URL,
so the subtask was keyed `bing.com` — which has no adapter — and every live
collect died with `No search fallback for bing.com`.

Seed URLs (`src/lib/catalog.ts`) now point at amazon.eg's own
`https://www.amazon.eg/s?k=<title>` results pages, so `domainOf` yields
`amazon.eg` and the adapter branch runs. Render behavior is unchanged:
`resolveOfferUrl` (`src/lib/links.ts`) still builds Bing search hrefs for
non-healthlisted hosts.

Regression guard: `seed catalog dispatch routing` test in
`src/lib/collect/search-fallback.test.ts` asserts every Jarir/Amazon.eg
seeded offer resolves to its retailer host (not a redirector).

## Verification done this run
- Live contract check (HTTP): `https://www.jarir.com/` → 200 with SSR payload;
  `https://www.amazon.eg/s?k=Keychron%20V3%20Max%20QMK...` → 200 with
  server-rendered `s-search-result` cards. Both parser anchor sets present.
- `npm test` could not execute in the harness run: the host reports "sandbox
  mode workspace-write ... no sandbox backend is usable" and escalation needs
  an unavailable approval channel. Re-run `npm run test` (vitest) on a normal
  dev/Vercel environment to confirm green.

## QA re-run checklist (owner: QA agent)
1. `npm run test` — expect `src/lib/collect/search-fallback.test.ts` green.
2. Serve (`npm run build && npm start`), open `/product/asus-rog-strix-scope-ii`,
  trigger collect; Jarir and Amazon.eg subtasks should reach `done` with one
   live offer each (SAR / EGP prices).
3. Note: Berry Electronics offers intentionally keep Bing search hrefs
  (merchant domain verified unreachable in REEA-25); their subtask failing is
  expected behavior, not a regression.
