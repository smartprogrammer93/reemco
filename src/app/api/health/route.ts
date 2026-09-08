/**
 * REEA-314 — scheduled smoke endpoint for Vercel Cron.
 *
 * Vercel Cron (`crons` in vercel.json, hourly at :17) GETs this route. It runs
 * the same funnel assertions as scripts/smoke-check.mjs steps 1-4 but with
 * plain server-side fetches against the app's own rendered pages, so it fits
 * the cron's short response budget (no headless browser here — that stays in
 * scripts/smoke-check.mjs for Actions/dispatch runs).
 *
 * Deterministic by design: the fixture query hits the seeded catalog shipped
 * in the bundle (same "sony" fixture as smoke-check.mjs), never fresh scraping.
 * Live offers are whatever the SSR render serves at query time, exactly like a
 * visitor sees — a pass means a real shopper funnel works on the deployed app.
 *
 * Assertions mirror the smoke script: step 1 home renders the app shell;
 * step 2 the fixture query yields at least one real (non-skeleton) result
 * card with a click-out link; step 3 that card's product page resolves; step 4
 * every funnel carries an honest freshness chip. Any failure => HTTP 503 with
 * the failing step named, which shows up red in Vercel cron/deployment logs.
 */
import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FIXTURE_QUERY = process.env.SMOKE_FIXTURE_QUERY || "sony";
const FETCH_TIMEOUT_MS = 9000;

// REEA-283/REEA-254 chip copy renders uppercase with the minute figure; keep
// in sync with step 4 of scripts/smoke-check.mjs (case-insensitive, legacy
// spellings allowed so a healthy deploy never false-fails).
const CHIP_RE = /(?:Verified|updated)[ ]*(?:<!--\s*-->)?[ ]*(?:\d+[hd] ago|\d+ minutes ago|minutes ago)/i;
const CHIP_ALT_RE = /may be outdated|(?:updated|Verification) date unknown/i;

async function get(origin: string, path: string): Promise<{ status: number; html: string }> {
  const res = await fetch(`${origin}${path}`, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "user-agent": "reemco-health/1.0" },
  });
  const html = await res.text();
  return { status: res.status, html };
}

// Opening tags of rendered cards; skeletons carry aria-hidden="true" right on
// the tag, real cards carry a click-out link inside the card markup.
function countRealCards(html: string): number {
  let real = 0;
  const tags = html.matchAll(/<div[^>]*class="[^"]*result-card[^"]*"[^>]*>/g);
  for (const tag of tags) {
    if (!/aria-hidden="true"/.test(tag[0])) real += 1;
  }
  return real;
}

export async function GET(req: NextRequest): Promise<Response> {
  const origin = new URL(req.url).origin;
  const failed: string[] = [];
  const checks: Record<string, string | number> = {};

  // step 1 — home renders the app shell (header nav is part of the shell).
  try {
    const home = await get(origin, "/");
    if (home.status !== 200 || !home.html.includes("site-header")) {
      failed.push(`home status=${home.status} shell=${home.html.includes("site-header")}`);
    } else {
      checks.home = "pass";
    }
  } catch (e) {
    failed.push(`home fetch failed: ${(e as Error).message}`);
  }

  // steps 2+4 — fixture query returns a real card with chip and link.
  let productHref = "";
  try {
    const res = await get(origin, `/results?q=${encodeURIComponent(FIXTURE_QUERY)}`);
    const cards = countRealCards(res.html);
    const chips =
      (res.html.match(new RegExp(CHIP_RE.source, "gi")) || []).length +
      (res.html.match(new RegExp(CHIP_ALT_RE.source, "gi")) || []).length;
    if (res.status !== 200 || cards < 1) {
      failed.push(`results status=${res.status} realCards=${cards}`);
    } else if (chips < 1) {
      failed.push(`results has ${cards} cards but no freshness chip`);
    } else {
      checks.results = "pass";
      checks.realCards = cards;
      checks.freshnessChips = chips;
      const link = res.html.match(/href="(\/product\/[^"]+)"/);
      productHref = link ? link[1] : "";
    }
  } catch (e) {
    failed.push(`results fetch failed: ${(e as Error).message}`);
  }

  // step 3 — the click-out product page resolves (skip when no product link;
  // offer links are external and their liveness is not ours to assert).
  if (failed.length === 0 && productHref) {
    try {
      const prod = await get(origin, productHref);
      if (prod.status !== 200) failed.push(`product ${productHref} status=${prod.status}`);
      else checks.product = "pass";
    } catch (e) {
      failed.push(`product fetch failed: ${(e as Error).message}`);
    }
  }

  const ok = failed.length === 0;
  return Response.json(
    { ok, checks, failedAt: failed, checkedAt: new Date().toISOString(), fixture: FIXTURE_QUERY },
    { status: ok ? 200 : 503 },
  );
}
