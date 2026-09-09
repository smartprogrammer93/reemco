/**
 * REEA-314 — scheduled smoke endpoint for Vercel Cron.
 *
 * Vercel Cron (`crons` in vercel.json, hourly at :17) GETs this route. It runs
 * the same funnel assertions as scripts/smoke-check.mjs steps 1-4 but with
 * plain server-side fetches against the app's own rendered pages, so it fits
 * the cron's short response budget (no headless browser here — that stays in
 * scripts/smoke-check.mjs for Actions/dispatch runs).
 *
 * Deterministic by design: the fixture query matches the seeded catalog the
 * smoke script uses too ("sony"), so a pass means the real shopper funnel —
 * live offers included — renders on the deployed artifact.
 *
 * Assertions mirror the smoke script: step 1 home renders the app shell;
 * step 2 the fixture query yields at least one real result card with a
 * freshness chip; step 3 a card's product page resolves. Failure => HTTP 503
 * naming the failed step, visible in Vercel cron/deployment logs. Skeletons
 * render class skeleton-card (never result-card), so any result-card match is
 * a real card.
 *
 * REEA-377: the served body is the minimal shape — `{ok, build}` (verdict +
 * build stamp) — while the per-step internals (card/chip counts, fixture
 * name, checkedAt/failedAt) go to the function console instead, so a public
 * GET leaks nothing beyond the verdict. GET shares the REEA-37 sliding-window
 * checkRateLimit: while inside the limit the funnel runs and its verdict is
 * cached in memory; past the limit the cached verdict is replayed without a
 * re-walk, so hammering one anonymous endpoint cannot re-run the whole site
 * walk on every hit. Step 3 stays a hard assertion; its hop budget (25 s,
 * REEA-391 tier) covers the measured cold walk so a healthy funnel flips the
 * scheduled tick green rather than sitting at 503.
 */
import type { NextRequest } from "next/server";
import { checkRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// REEA-369: the funnel hops walk pages whose segment ceilings now sit at the
// measured-walk headroom tier (results and product pages; REEA-391), and a
// cold cron call runs home + results + product after a cold start — measured
// ~26 s end to end on the first request after a deploy. The function gets
// headroom above that sum.
export const maxDuration = 60;

const FIXTURE_QUERY = process.env.SMOKE_FIXTURE_QUERY || "sony";
// Results pages stream staged live collections (page ceilings on the 45 s
// measured-walk tier since REEA-391), so the funnel fetches get generous
// per-hop budgets under the cron window: they must cover the measured walk
// (warm ~21 s / cold ~26 s), not the ceiling itself. With the product hop at
// 12 s the first cold request spent its whole chain in connection setup +
// staged collection and aborted a page that answers inside its own budget
// right after (QA REEA-369 repro).
const HOME_TIMEOUT_MS = 12000;
const RESULTS_TIMEOUT_MS = 30000;
const PRODUCT_TIMEOUT_MS = 25000;

// REEA-283/REEA-254 chip copy renders uppercase with the minute figure; keep
// in sync with step 4 of scripts/smoke-check.mjs (case-insensitive, legacy
// spellings allowed so a healthy deploy never false-fails).
const CHIP_RE = "(?:Verified|updated)[ ]*(?:<!--[ ]-->)?[ ]*(?:\\d+[hd] ago|\\d+ minutes ago|minutes ago)";
const CHIP_ALT_RE = "may be outdated|(?:updated|Verification) date unknown";

async function get(origin: string, path: string, timeoutMs: number) {
  // REEA-369 — one bounded retry. The first request after a deploy walks a
  // cold instance through connection setup on every hop; when a hop still
  // spends its window, the very next attempt lands on the warmed instance
  // and answers in about a second (measured on prod: first call ~26 s with
  // the product hop aborted, immediate re-check HTTP 200 in ~1 s). Without
  // the retry the cron tick reports a false failure for the whole hour.
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${origin}${path}`, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": "reemco-health/1.0" },
      });
      const html = await res.text();
      if (res.status === 200 || attempt === 1) return { status: res.status, html };
    } catch (e) {
      lastError = (e as Error).message;
    }
  }
  throw new Error(lastError || "fetch failed");
}

// Offer/product cards render as <article class="result-card ..."> (see
// OfferCard/ProductResultCard); skeletons use skeleton-card and never match.
function countCards(html: string): number {
  return (html.match(/class="[^"]*\bresult-card\b/g) || []).length;
}

// REEA-377 build stamp: Vercel injects VERCEL_GIT_COMMIT_SHA at build time
// (same value the build command writes to public/__commit.txt). Not a secret;
// a short SHA is what rollback instructions reference.
const BUILD_SHA = (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 12);

// Last funnel verdict, memory-only — same lifecycle as the rate-limit buckets
// in lib/rate-limit.ts; a new instance simply re-runs the funnel once.
let lastVerdict: { ok: boolean } | null = null;

// Same caller key as the /api/events limiter (client IP from the proxy chain).
function clientKey(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : "") || req.headers.get("x-real-ip") || "unknown";
}

function verdictResponse(ok: boolean): Response {
  return Response.json({ ok, build: BUILD_SHA }, { status: ok ? 200 : 503 });
}

export async function GET(req: NextRequest): Promise<Response> {
  // REEA-377: reuse the REEA-37 limiter on the GET path. Inside the window
  // the funnel runs (and caches its verdict); past it the cached verdict is
  // replayed so repeated hits do not each re-walk home → results → product.
  const gate = checkRateLimit(clientKey(req), Date.now());
  if (!gate.allowed && lastVerdict) return verdictResponse(lastVerdict.ok);

  const origin = new URL(req.url).origin;
  const failed: string[] = [];
  const checks: Record<string, string | number> = {};

  // step 1 — home renders the app shell (header nav is part of the shell).
  try {
    const home = await get(origin, "/", HOME_TIMEOUT_MS);
    if (home.status !== 200 || !home.html.includes("site-header")) {
      failed.push(`home status=${home.status} shell=${home.html.includes("site-header")}`);
    } else {
      checks.home = "pass";
    }
  } catch (e) {
    failed.push(`home fetch failed: ${(e as Error).message}`);
  }

  // steps 2+4 — fixture query returns real cards wearing freshness chips.
  let productHref = "";
  try {
    const res = await get(origin, `/results?q=${encodeURIComponent(FIXTURE_QUERY)}`, RESULTS_TIMEOUT_MS);
    const cards = countCards(res.html);
    const chips =
      (res.html.match(new RegExp(CHIP_RE, "gi")) || []).length +
      (res.html.match(new RegExp(CHIP_ALT_RE, "gi")) || []).length;
    if (res.status !== 200 || cards < 1) {
      failed.push(`results status=${res.status} cards=${cards}`);
    } else if (chips < 1) {
      failed.push(`results has ${cards} cards but no freshness chip`);
    } else {
      checks.results = "pass";
      checks.cards = cards;
      checks.freshnessChips = chips;
      const link = res.html.match(/href="(\/product\/[^"]+)"/);
      productHref = link ? link[1] : "";
    }
  } catch (e) {
    failed.push(`results fetch failed: ${(e as Error).message}`);
  }

  // step 3 — the click-out product page resolves (skip when the first card
  // carries only an external offer link; its liveness is not ours to assert).
  if (failed.length === 0 && productHref) {
    try {
      const prod = await get(origin, productHref, PRODUCT_TIMEOUT_MS);
      if (prod.status !== 200) failed.push(`product ${productHref} status=${prod.status}`);
      else checks.product = "pass";
    } catch (e) {
      failed.push(`product fetch failed: ${(e as Error).message}`);
    }
  }

  const ok = failed.length === 0;
  const checkedAt = new Date().toISOString();
  // Internals to console logs only (REEA-377): Vercel function logs keep the
  // full step detail, the served body stays the minimal {ok, build} shape.
  const detail = `fixture=${FIXTURE_QUERY} checks=${JSON.stringify(checks)} failedAt=${JSON.stringify(failed)} checkedAt=${checkedAt}`;
  if (ok) console.log(`health pass ${detail}`);
  else console.error(`health FAIL ${detail}`);
  lastVerdict = { ok };
  return verdictResponse(ok);
}
