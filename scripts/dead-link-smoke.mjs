/**
 * REEA-807 — dead-link smoke over LIVE offer URLs, recorded as aggregate
 * counters (no PII, nothing per-URL stored).
 *
 * Pulls the converged live snapshot for a couple of fixture queries from this
 * site's OWN results feed (/api/results-followup — the same single live
 * fan-out the results page runs, never a bundled catalog), samples a bounded
 * set of outbound offer URLs per retailer, checks them politely (per-host
 * identity, per-host pacing, per-URL timeout), and POSTs the aggregate
 * outcome to /api/metrics/link-smoke so it lands in the weekly PM snapshot.
 *
 * Usage: node scripts/dead-link-smoke.mjs
 *   SMOKE_BASE_URL   base to measure (default https://reemco.vercel.app)
 *   LINK_SMOKE_QUERIES  comma-separated fixture queries (default "sony,iphone")
 *   LINK_SMOKE_PER_RETAILER  max URLs checked per retailer (default 8)
 *   LINK_SMOKE_PAUSE_MS      min pause between same-host checks (default 300)
 *   LINK_SMOKE_CHALLENGE_BACKOFF_MS  backoff before the challenge retry (default 5000)
 *   LINK_SMOKE_TRANSIENT_BACKOFF_MS  backoff before the transient retry (default 2000)
 *
 * REEA-935 — the checker stops punishing itself (REEA-934 spec, REEA-922
 * root cause §5). Three changes, one outcome vocabulary:
 *   R1  per-host check identity mirroring each adapter's lead shape
 *       (HOST_IDENTITIES below — no host is measured under an identity+shape
 *       our live adapters never send);
 *   R2  challenge-aware checking: a bot-wall challenge (CF challenge 403 or
 *       a 429) is NOT a dead shopper link — one backoff retry with the same
 *       identity, then the outcome is `challenge`, never `dead`;
 *   R3  transient retry: network error / timeout / 5xx retries once after a
 *       short backoff before `dead` is recorded; definitive 404/410 never
 *       retry.
 * Every checked URL ends in exactly one of `ok` | `dead` | `challenge`, and
 * the weekly record keeps the per-outcome counts so the dead rate
 * (dead / (ok + dead)) is computed on links a shopper could actually reach.
 *
 * Never throws: exit 0 with a printed verdict, exit 1 only when the ingest
 * POST itself failed (the counters did not land).
 */
import { pathToFileURL } from "node:url";

const BASE = (process.env.SMOKE_BASE_URL || "https://reemco.vercel.app").replace(/\/$/, "");
const QUERIES = (process.env.LINK_SMOKE_QUERIES || "sony,iphone")
  .split(",")
  .map((q) => q.trim())
  .filter(Boolean)
  .slice(0, 4);
const PER_RETAILER = Math.max(1, Math.min(20, Number(process.env.LINK_SMOKE_PER_RETAILER) || 8));
const PAUSE_MS = Math.max(0, Number(process.env.LINK_SMOKE_PAUSE_MS) || 300);
const CHALLENGE_BACKOFF_MS = Math.max(0, Number(process.env.LINK_SMOKE_CHALLENGE_BACKOFF_MS) || 5_000);
const TRANSIENT_BACKOFF_MS = Math.max(0, Number(process.env.LINK_SMOKE_TRANSIENT_BACKOFF_MS) || 2_000);
const FETCH_TIMEOUT_MS = 10_000;

// REEA-935 (R1) — the liveness check presents a PER-HOST identity, resolved
// from this table and documented here, versioned with the code. Policy
// (REEA-934 spec Change 1, REEA-922 root cause, CEO-confirmed): every
// identity mirrors the LEAD request identity the matching live adapter
// actually sends — the smoke must measure the links the way our own traffic
// reaches them, never invent a new checker shape. NO SILENT SWAPS: any
// change here re-baselines the weekly dead-link number (run
// scripts/reea922-link-classify-probe.mjs before/after) and says so in the
// change's commit message.
//
// - amazon.eg "amazon-eg-adapter-lead": `user-agent: Mozilla/5.0` with
//   `accept-encoding` pinned EMPTY — byte-for-byte the lead hop its adapter
//   sends (REEA-397 pin in live-search.ts). Measured 2026-09-14 (REEA-922
//   diagnosis): amazon.eg's edge answers a deterministic 503 apology page to
//   the claimed-crawler UA when undici injects
//   `accept-encoding: br, gzip, deflate` (8/8 sampled /dp URLs), while the
//   adapter-shaped request answers 200 — the W37 Amazon.eg 15/49 "dead"
//   share was checker identity, not rot.
// - CF-challenge-zone rows "verified-crawler": the claimed-crawler UA the
//   zones' own adapters lead with (VERIFIED_BOT_HEADERS via
//   fetchThroughChallenge, search-fallback.ts). Measured 2026-09-08/09
//   (REEA-272/901, evidence host www.nextstore.com.kw — the same family as
//   www.luluhypermarket.com): these managed-challenge zones answer plain /
//   honest UAs with the HTTP 403 challenge shell on product URLs a real
//   browser passes interactively, while the crawler identity clears the rule
//   on the first hop. W37 recorded Next Store 3/3 "dead" that way.
// - DEFAULT "reemco-link-smoke": the honest declared UA (the pre-`daa7333`
//   identity). Measured across the REEA-922 identity matrix (2026-09-13/14):
//   it answered 200 on every sampled non-challenge host (old-UA amazon
//   control 4/4×200; Jarir/Eureka/Astore 0 dead across identities) and never
//   triggers bot punishment — the checker says who it is, and the hosts that
//   mind get their adapter's own shape instead.
const DEFAULT_IDENTITY = {
  label: "reemco-link-smoke",
  headers: { "user-agent": "reemco-link-smoke/1.0" },
};

/** The claimed-crawler identity the CF-challenge zones admit (evidence above). */
const CRAWLER_IDENTITY = {
  label: "verified-crawler",
  headers: {
    "user-agent":
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  },
};

/** Per-host identity table — see the policy comment above. */
const HOST_IDENTITIES = [
  {
    match: /(^|\.)amazon\.eg$/i,
    label: "amazon-eg-adapter-lead",
    headers: { "user-agent": "Mozilla/5.0", "accept-encoding": "" },
  },
  // CF managed-challenge zones whose adapter hop rides fetchThroughChallenge
  // (live-search.ts) — the crawler UA is the one identity these admit.
  { match: /(^|\.)nextstore\.com\.kw$/i, ...CRAWLER_IDENTITY },
  { match: /(^|\.)luluhypermarket\.com$/i, ...CRAWLER_IDENTITY },
  {
    match: /(^|\.)(bomai\.com|hobbycenter\.com\.kw|yaso\.com|yousifi\.com\.kw|alghanim-store\.com)$/i,
    ...CRAWLER_IDENTITY,
  },
];

/** Resolves one URL's check identity from the table (exported for pins). */
export function identityFor(url) {
  try {
    const host = new URL(url).hostname;
    const entry = HOST_IDENTITIES.find((e) => e.match.test(host)) ?? DEFAULT_IDENTITY;
    return { label: entry.label, headers: entry.headers };
  } catch {
    return { label: DEFAULT_IDENTITY.label, headers: DEFAULT_IDENTITY.headers };
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * REEA-935 (R2/R3) — classify ONE attempt's raw result into the check
 * vocabulary. Pure; exported for the stubbed-fetch pins.
 *  - "ok"         2xx/3xx (redirects are followed by fetch itself)
 *  - "dead"       definitive answer: 404/410, a plain 403 without challenge
 *                 markers, any other 4xx
 *  - "challenge"  bot-wall, not a dead link: HTTP 429, or a 403 carrying
 *                 `cf-mitigated: challenge` / a "Just a moment" body marker
 *  - "transient"  5xx — worth one backoff retry before `dead`
 * A thrown fetch (network error / the 10 s abort) is the caller's transient.
 */
export function classifyAttempt(status, resHeaders, bodySnip) {
  if (status >= 200 && status < 400) return "ok";
  if (status === 429) return "challenge";
  if (status === 403) {
    const mitigated = String(resHeaders?.get?.("cf-mitigated") ?? "").toLowerCase();
    if (mitigated === "challenge" || /just a moment/i.test(bodySnip ?? "")) return "challenge";
    return "dead";
  }
  if (status >= 500) return "transient";
  return "dead"; // 404/410 and every other 4xx: the server answered, definitively
}

/** One bounded fetch; returns {status, headers, bodySnip} or throws. */
async function fetchAttempt(fetchImpl, url, headers, timeoutMs) {
  const res = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
  });
  // The challenge marker can ride the body (CF interstitial). Read it only
  // where it matters (non-2xx), bounded — a challenge page is small, and the
  // cap keeps a hostile body from ballooning the check.
  let bodySnip = "";
  if (res.status >= 400) {
    try {
      bodySnip = (await res.text()).slice(0, 4096);
    } catch {
      bodySnip = "";
    }
  }
  return { status: res.status, headers: res.headers, bodySnip };
}

/**
 * REEA-935 — the full check for one URL: up to two attempts under the
 * classification rules above.
 *  - attempt 1 challenge  → backoff `challengeBackoffMs` (≥ 5 s in prod, the
 *    REEA-922 pacing that stops provoking the wall) → retry, same identity;
 *    still challenged ⇒ "challenge" (the link works interactively — a false
 *    "dead" erodes trust in the metric more than a flagged unknown).
 *  - attempt 1 transient  → backoff `transientBackoffMs` (2 s) → retry;
 *    still failing ⇒ "dead" (network error ×2 / persistent 5xx ×2).
 *  - attempt 1 ok/dead    → final, no retry (retries are for transient
 *    classes only — a definitive 404 never burns a second request).
 * Injectables keep the pins sleep-free (AC-2.1). Returns the outcome plus
 * the attempt count so a "dead" record is auditable as retried-then-failed.
 */
export async function checkUrl(fetchImpl, url, opts = {}) {
  const headers = opts.headers ?? identityFor(url).headers;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  const challengeBackoffMs = opts.challengeBackoffMs ?? CHALLENGE_BACKOFF_MS;
  const transientBackoffMs = opts.transientBackoffMs ?? TRANSIENT_BACKOFF_MS;
  const sleepFn = opts.sleep ?? sleep;

  const attemptOnce = async () => {
    try {
      const r = await fetchAttempt(fetchImpl, url, headers, timeoutMs);
      return { classified: classifyAttempt(r.status, r.headers, r.bodySnip), raw: r };
    } catch {
      return { classified: "transient", raw: null }; // network error / timeout
    }
  };

  let attempt = await attemptOnce();
  let attempts = 1;
  if (attempt.classified === "challenge") {
    if (challengeBackoffMs > 0) await sleepFn(challengeBackoffMs);
    attempt = await attemptOnce();
    attempts += 1;
    return {
      outcome: attempt.classified === "ok" ? "ok" : attempt.classified === "transient" ? "dead" : "challenge",
      attempts,
    };
  }
  if (attempt.classified === "transient") {
    if (transientBackoffMs > 0) await sleepFn(transientBackoffMs);
    attempt = await attemptOnce();
    attempts += 1;
    return { outcome: attempt.classified === "ok" ? "ok" : "dead", attempts };
  }
  return { outcome: attempt.classified, attempts }; // "ok" or "dead", final
}

/**
 * REEA-935 — polite pacing (spec AC-2.4): two consecutive requests to the
 * SAME host are separated by at least `pauseMs`. Tracked per host (not per
 * check) so the floor holds no matter how the queue interleaves merchants.
 * Injected clock/timer keep the pin sleep-free.
 */
export async function checkQueueWithPacing(items, deps = {}) {
  const check = deps.check ?? ((url) => checkUrl(fetch, url));
  const pauseMs = deps.pauseMs ?? PAUSE_MS;
  const sleepFn = deps.sleep ?? sleep;
  const now = deps.now ?? Date.now;
  const nextAllowedAt = new Map(); // host -> epoch ms the next check may start
  const results = [];
  for (const item of items) {
    let host = null;
    try {
      host = new URL(item.url).hostname;
    } catch {
      host = null;
    }
    if (host) {
      const wait = (nextAllowedAt.get(host) ?? 0) - now();
      if (wait > 0) await sleepFn(wait);
    }
    const outcome = await check(item.url);
    // The floor anchors on the PREVIOUS check's END, so the gap between two
    // same-host requests is pauseMs regardless of how long a check itself ran.
    if (host) nextAllowedAt.set(host, now() + pauseMs);
    results.push({ ...item, outcome });
  }
  return results;
}

/** Live snapshot for one fixture query — the site's own converged fan-out.
 *
 * REEA-922 fix 2/2 — ONE retry when the feed answers nothing useful. The
 * route answers `null` while a cold cross-worker run is still converging (its
 * bounded wait can expire before the chain lands), and an immediate repeat
 * rides that run's memo/registration and answers in full — observed live
 * 2026-09-14: a cold follow-up call waited out its 8 s window for "iphone"
 * and returned null (0 offers sampled for the whole fixture query), while the
 * immediate repeat answered 50 offers. A single-shot sampling fetch starves
 * the sample exactly when the feed is slow-but-healthy; the retry keeps the
 * smoke's pacing polite (one pause, still one bounded fetch pair per query).
 */
async function collectOffers(query) {
  const url = `${BASE}/api/results-followup?q=${encodeURIComponent(query)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(1500);
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: "follow",
      });
      if (!res.ok) {
        console.log(`WARN ${res.status} ${url}`);
        continue;
      }
      const snap = await res.json();
      const products = Array.isArray(snap?.products) ? snap.products : [];
      const out = [];
      for (const p of products) {
        for (const o of Array.isArray(p?.offers) ? p.offers : []) {
          if (typeof o?.url === "string" && typeof o?.merchant === "string" && /^https?:\/\//.test(o.url)) {
            out.push({ merchant: o.merchant, url: o.url });
          }
        }
      }
      if (out.length > 0 || attempt === 1) return out;
    } catch (e) {
      console.log(`WARN followup fetch failed for "${query}": ${e?.message ?? e}`);
    }
  }
  return [];
}

async function main() {
  // ---- collect a bounded, deduped sample per retailer ----
  const perRetailer = new Map(); // merchant -> { queue: [...] }
  const seenUrls = new Set();
  for (const q of QUERIES) {
    const offers = await collectOffers(q);
    console.log(`query "${q}": ${offers.length} live offers in the converged snapshot`);
    for (const o of offers) {
      if (seenUrls.has(o.url)) continue;
      seenUrls.add(o.url);
      const bucket = perRetailer.get(o.merchant) ?? { queue: [] };
      if (bucket.queue.length < PER_RETAILER) bucket.queue.push(o.url);
      perRetailer.set(o.merchant, bucket);
    }
  }

  // ---- check with per-host pacing; fold into ok/dead/challenge ----
  let checked = 0;
  let dead = 0;
  let challenge = 0;
  for (const [merchant, bucket] of [...perRetailer.entries()].sort()) {
    const results = await checkQueueWithPacing(bucket.queue.map((url) => ({ merchant, url })));
    const counts = { checked: 0, dead: 0, challenge: 0 };
    for (const r of results) {
      counts.checked += 1;
      checked += 1;
      if (r.outcome === "dead") {
        counts.dead += 1;
        dead += 1;
        console.log(`DEAD ${r.url}`);
      } else if (r.outcome === "challenge") {
        counts.challenge += 1;
        challenge += 1;
        console.log(`CHALLENGE ${r.url}`);
      }
    }
    perRetailer.set(merchant, counts);
    console.log(
      `${merchant}: ${counts.checked} checked, ${counts.dead} dead, ${counts.challenge} challenge`,
    );
  }
  const ok = Math.max(0, checked - dead - challenge);
  console.log(`outcomes: ${ok} ok / ${dead} dead / ${challenge} challenge`);

  // ---- record the aggregate outcome ----
  const byRetailer = {};
  for (const [merchant, c] of perRetailer) {
    if (!c.queue) byRetailer[merchant] = { checked: c.checked, dead: c.dead, challenge: c.challenge };
  }

  const ingest = `${BASE}/api/metrics/link-smoke`;
  try {
    const res = await fetch(ingest, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ checked, dead, challenge, by_retailer: byRetailer }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      console.log(
        `LINK SMOKE PASSED — recorded ${checked} checked / ${dead} dead / ${challenge} challenge to ${ingest}`,
      );
    } else {
      console.error(`LINK SMOKE INGEST FAILED — ${res.status} from ${ingest}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`LINK SMOKE INGEST FAILED — ${e?.message ?? e} (${ingest})`);
    process.exit(1);
  }
}

// Run the smoke only when executed directly (the vitest pins import this
// module for its pure/injectable pieces and must not fire live fetches).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
