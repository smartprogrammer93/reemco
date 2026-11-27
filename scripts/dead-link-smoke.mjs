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
 * REEA-1252 — the guardrail must be able to fail. The pre-v5 weekly sample was
 * 320 links; the two fixed queries ("sony,iphone") collapsed it to a token
 * 16/week because they cover almost none of the rendered population and one of
 * them (iphone) now converges to zero products. This script now states and
 * enforces the rule:
 *
 *   SCHEDULE  reemco-link-smoke.timer (host systemd, infra/systemd/) runs this
 *             daily at 09:10 UTC; the app's /api/health after() runner is the
 *             once-per-UTC-day fallback. Both paths use this same script, so a
 *             missed timer still gets a run that day.
 *   SELECTION 6 broad queries/day drawn from a 12-query rotating pool
 *             (UTC-day rotation, LINK_SMOKE_QUERY_POOL) and read LIVE from
 *             /api/results-followup — the same converged fan-out the results
 *             page paints — so the sample is the rendered offer-link
 *             population, never a static URL list. Max 8 links per retailer
 *             and max 96 links per run, spread round-robin across retailers so
 *             one merchant cannot crowd out the rest.
 *   FLOOR     320 checked links/week (the pre-v5 design ceiling: 20 retailers
 *             x 8 links x 2 queries). 7 days x 96 max = 672; the daily floor
 *             the monitor enforces is ceil(320/7) = 46 checked/run. A run that
 *             plans fewer than 46 from the rotated queries tops up from the
 *             REMAINING pool queries (bounded: LINK_SMOKE_TOPUP_MAX_QUERIES,
 *             default 6) so a low-yield rotation day still carries its share
 *             of the week. Explicit LINK_SMOKE_QUERIES overrides skip the top-up.
 *   ALERT     scripts/link-smoke-monitor.mjs +
 *             .github/workflows/link-smoke-monitor.yml fail when a complete
 *             week is under the floor, has < 7 runs, dead_rate > 10% or
 *             challenge_rate > 25%, and open a `link-smoke-alert` issue.
 *             The in-progress week is graded against the prorated floor so the
 *             monitor cannot go quiet mid-week; the proration counts only the
 *             days the guardrail has been armed (THRESHOLDS.armedSince), so the
 *             restore week is not failed for days that predate the schedule.
 *
 * Usage: node scripts/dead-link-smoke.mjs
 *   SMOKE_BASE_URL   base to measure (default https://ns539626.ip-144-217-72.net)
 *   LINK_SMOKE_QUERY_POOL  rotating broad-query pool (default: 12 categories)
 *   LINK_SMOKE_QUERIES_PER_RUN  queries sampled per run (default 6, max 8)
 *   LINK_SMOKE_QUERIES  explicit comma-separated queries (overrides the pool)
 *   LINK_SMOKE_PER_RETAILER  max URLs checked per retailer (default 8, max 20)
 *   LINK_SMOKE_MAX_CHECKS    max URLs checked per run (default 96, max 500)
 *   LINK_SMOKE_DAILY_FLOOR   per-run checked floor the top-up aims for (default 46)
 *   LINK_SMOKE_TOPUP_MAX_QUERIES  max extra queries used for the top-up (default 6)
 *   LINK_SMOKE_SAMPLING_TIMEOUT_MS  follow-up feed wait per attempt (default 22000)
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

const BASE = (process.env.SMOKE_BASE_URL || "https://ns539626.ip-144-217-72.net").replace(/\/$/, "");

/** Comma-list env parsing with a hard count cap (never trust the environment). */
function parseList(raw, max) {
  return String(raw ?? "")
    .split(",")
    .map((q) => q.trim())
    .filter(Boolean)
    .slice(0, max);
}

/** Integer env parsing with a clamp; an absent/invalid value falls back. */
function intEnv(name, fallback, min, max) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/**
 * REEA-1252 — broad-query pool covering the categories the results page
 * renders. The URLs themselves always come LIVE from the feed; the pool only
 * selects which slice of that rendered population is sampled each day, and the
 * UTC-day rotation keeps the weekly sample from re-checking one fixed list.
 */
const QUERY_POOL = parseList(
  process.env.LINK_SMOKE_QUERY_POOL ||
    "iphone 17 pro,nintendo switch 2,headphones,panadol,perfume,laptop,tv,air fryer,washing machine,coffee machine,backpack,playstation 5",
  16,
);
const QUERIES_PER_RUN = intEnv("LINK_SMOKE_QUERIES_PER_RUN", 6, 1, 8);
/** Explicit override (tests / one-off runs): exactly this list. */
const QUERIES_OVERRIDE = process.env.LINK_SMOKE_QUERIES
  ? parseList(process.env.LINK_SMOKE_QUERIES, 8)
  : null;
const PER_RETAILER = intEnv("LINK_SMOKE_PER_RETAILER", 8, 1, 20);
const MAX_CHECKS_PER_RUN = intEnv("LINK_SMOKE_MAX_CHECKS", 96, 1, 500);
/**
 * REEA-1252 — the daily floor the monitor grades against (ceil(320/7) = 46).
 * A run that plans fewer links than this cannot carry its share of the week,
 * so the sampler tops up (see runDeadLinkSmoke) instead of recording a thin day.
 */
const DAILY_FLOOR = intEnv("LINK_SMOKE_DAILY_FLOOR", 46, 1, 500);
/** Bounded extra feed queries used to reach the daily floor (see below). */
const TOPUP_MAX_QUERIES = intEnv("LINK_SMOKE_TOPUP_MAX_QUERIES", 6, 0, 12);
const SAMPLING_TIMEOUT_MS = intEnv("LINK_SMOKE_SAMPLING_TIMEOUT_MS", 22_000, 5_000, 45_000);
const PAUSE_MS = Math.max(0, Number(process.env.LINK_SMOKE_PAUSE_MS) || 300);
const CHALLENGE_BACKOFF_MS = Math.max(0, Number(process.env.LINK_SMOKE_CHALLENGE_BACKOFF_MS) || 5_000);
const TRANSIENT_BACKOFF_MS = Math.max(0, Number(process.env.LINK_SMOKE_TRANSIENT_BACKOFF_MS) || 2_000);
const FETCH_TIMEOUT_MS = 10_000;

/**
 * REEA-1252 — pick the day's queries. Deterministic rotation by UTC day over
 * the pool so consecutive days cover different categories and a week covers
 * the pool once. Exported for pins (no network, injected clock).
 */
export function selectQueries(now = Date.now(), opts = {}) {
  if (opts.queries) return opts.queries.slice(0, 8);
  const pool = (opts.pool ?? QUERY_POOL).filter(Boolean);
  if (pool.length === 0) return [];
  const count = Math.max(1, Math.min(opts.count ?? QUERIES_PER_RUN, 8, pool.length));
  const day = Math.floor(now / 86_400_000);
  const start = (day * count) % pool.length;
  const out = [];
  for (let i = 0; i < count; i++) out.push(pool[(start + i) % pool.length]);
  return out;
}

/**
 * REEA-1252 — turn the per-retailer buckets into the run's check plan.
 * Round-robin across retailers (sorted for determinism) until the per-run cap
 * is reached, so one merchant with many offers cannot crowd the others out.
 * Pure; exported for pins.
 */
export function planSample(perRetailer, maxChecks) {
  const queues = [...perRetailer.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([merchant, bucket]) => ({ merchant, urls: [...(bucket.queue ?? [])] }));
  const planned = [];
  let cursor = 0;
  while (planned.length < maxChecks && queues.some((q) => q.urls.length > 0)) {
    const q = queues[cursor % queues.length];
    if (q.urls.length > 0) planned.push({ merchant: q.merchant, url: q.urls.shift() });
    cursor += 1;
  }
  return planned;
}

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
 *                 `cf-mitigated` (any value), Cloudflare's block page
 *                 ("Attention Required! | Cloudflare", `server: cloudflare`)
 *                 or a JS/cookie interstitial ("Just a moment", "Checking
 *                 your browser") — REEA-1154/REEA-1166
 *  - "transient"  5xx — worth one backoff retry before `dead`
 * A thrown fetch (network error / the 10 s abort) is the caller's transient.
 *
 * REEA-1166 — a Cloudflare BLOCK page (HTTP 403, title
 * "Attention Required! | Cloudflare") is the same class as the JS challenge:
 * the edge answered and a real shopper browser gets the page, while the smoke
 * runner's plain fetch is refused. Talabat's `/en/kuwait` offer URL answers
 * exactly that shape from the deploy runner, so counting it as `dead` rolled
 * back every deploy. It stays a challenge (reachable-but-bot-blocked), never
 * an `ok` 200 and never a `dead`; a genuine 404/410/plain 403/5xx is untouched.
 */
const BOT_WALL_BODY_RE =
  /just a moment|attention required|checking your browser|enable javascript and cookies to continue|cf-browser-verification/i;

export function classifyAttempt(status, resHeaders, bodySnip) {
  if (status >= 200 && status < 400) return "ok";
  if (status === 429) return "challenge";
  if (status === 403) {
    // REEA-1154/REEA-1166 — Cloudflare intervened: any `cf-mitigated` value
    // ("challenge", "block"), a response served by Cloudflare's edge, or a
    // challenge/block body marker means a real browser gets the page while a
    // plain fetch is refused. A plain 403 from any other origin stays dead.
    const mitigated = String(resHeaders?.get?.("cf-mitigated") ?? "").toLowerCase();
    if (mitigated) return "challenge";
    const server = String(resHeaders?.get?.("server") ?? "").toLowerCase();
    if (server === "cloudflare") return "challenge";
    if (BOT_WALL_BODY_RE.test(bodySnip ?? "")) return "challenge";
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
async function collectOffers(query, opts = {}) {
  const base = (opts.base ?? BASE).replace(/\/$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  // REEA-1252 — the follow-up feed waits up to LIVE_SEARCH_BUDGET_MS (16 s) for
  // a cold cross-worker run to converge; the old 10 s ceiling aborted it and
  // starved the whole query. The sampling wait must sit ABOVE that budget.
  const timeoutMs = opts.timeoutMs ?? SAMPLING_TIMEOUT_MS;
  const url = `${base}/api/results-followup?q=${encodeURIComponent(query)}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await (opts.sleep ?? sleep)(1500);
    try {
      const res = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
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

/**
 * REEA-1078 — the callable smoke runner. Same collection, pacing, identity and
 * outcome classification as the CLI, but it RETURNS the aggregate instead of
 * posting it, so the app can run the daily smoke in-process (the existing
 * health timer is the fallback schedule) and record the counters directly.
 * `base` is the origin whose own converged feed is sampled; `fetchImpl`/`sleep`
 * /pacing/clock are injectable so the pins stay network-free.
 *
 * REEA-1252 — the sample is no longer two fixed queries. It is 6 broad queries
 * from a UTC-day-rotated pool, read live from the rendered results feed, capped
 * at 8 per retailer and 96 per run and spread round-robin across retailers.
 * See the script header for the stated rule and the 320/week floor.
 *
 * Returns { checked, dead, challenge, ok, byRetailer } with every checked URL
 * in exactly one of ok/dead/challenge (REEA-935 vocabulary). Never throws on
 * a per-URL failure — those are counted outcomes; only a caller-level error
 * (e.g. no feed at all) surfaces as a zero-check result.
 */
export async function runDeadLinkSmoke(opts = {}) {
  const base = (opts.base ?? BASE).replace(/\/$/, "");
  const now = opts.now ?? Date.now();
  const queries =
    opts.queries ?? QUERIES_OVERRIDE ?? selectQueries(now, { pool: opts.queryPool, count: opts.queriesPerRun });
  const perRetailerLimit = Math.max(1, Math.min(20, Number(opts.perRetailer ?? PER_RETAILER) || 8));
  const maxChecks = Math.max(1, Math.min(500, Number(opts.maxChecks ?? MAX_CHECKS_PER_RUN) || 96));
  const samplingTimeoutMs = Math.max(
    5_000,
    Math.min(45_000, Number(opts.samplingTimeoutMs ?? SAMPLING_TIMEOUT_MS) || 22_000),
  );
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleepFn = opts.sleep ?? sleep;
  const pauseMs = Math.max(0, Number(opts.pauseMs ?? PAUSE_MS) || 0);

  console.log(`sample queries (UTC-day rotation): ${queries.join(", ") || "(none)"}`);

  // ---- collect a bounded, deduped sample per retailer ----
  const perRetailer = new Map(); // merchant -> { queue: [...] }
  const seenUrls = new Set();
  const addOffers = (offers) => {
    for (const o of offers) {
      if (seenUrls.has(o.url)) continue;
      seenUrls.add(o.url);
      const bucket = perRetailer.get(o.merchant) ?? { queue: [] };
      if (bucket.queue.length < perRetailerLimit) bucket.queue.push(o.url);
      perRetailer.set(o.merchant, bucket);
    }
  };
  const sampleQuery = async (q) => {
    const offers = await collectOffers(q, {
      base,
      fetchImpl,
      sleep: sleepFn,
      timeoutMs: samplingTimeoutMs,
    });
    console.log(`query "${q}": ${offers.length} live offers in the converged snapshot`);
    addOffers(offers);
    return offers.length;
  };

  for (const q of queries) await sampleQuery(q);

  // ---- plan the run's sample (round-robin, hard per-run cap) ----
  let planned = planSample(perRetailer, maxChecks);

  // REEA-1252 (follow-up) — the rotation can land on a low-yield day: six thin
  // categories still cover retailers but plan under the 46/day floor, so the
  // week would miss 320 without the guardrail ever failing. The floor is the
  // point, so when the initial plan is short we draw the REMAINING pool queries
  // (never re-using one already sampled) until the plan reaches DAILY_FLOOR or
  // the pool / LINK_SMOKE_TOPUP_MAX_QUERIES budget is exhausted. Explicit
  // query overrides (tests, one-off probes) are honoured exactly: no top-up.
  const topUpFloor = Math.max(1, Math.min(maxChecks, Number(opts.dailyFloor ?? DAILY_FLOOR) || 46));
  const topUpMax = Math.max(0, Math.min(12, Number(opts.topUpMaxQueries ?? TOPUP_MAX_QUERIES) || 0));
  if (!opts.queries && !QUERIES_OVERRIDE && topUpMax > 0) {
    const pool = (opts.queryPool ?? QUERY_POOL).filter(Boolean);
    const used = new Set(queries.map((q) => q.trim().toLowerCase()));
    let extra = 0;
    for (const q of pool) {
      if (planned.length >= topUpFloor || extra >= topUpMax) break;
      if (used.has(q.trim().toLowerCase())) continue;
      used.add(q.trim().toLowerCase());
      extra += 1;
      await sampleQuery(q);
      planned = planSample(perRetailer, maxChecks);
    }
    if (extra > 0) {
      console.log(`floor top-up: sampled ${extra} extra queries toward the ${topUpFloor}/run floor`);
    }
  }

  const plannedRetailers = new Set(planned.map((p) => p.merchant)).size;
  console.log(
    `sample plan: ${planned.length} links across ${plannedRetailers} retailers (cap ${maxChecks}/run, ${perRetailerLimit}/retailer, floor ${topUpFloor}/run)`,
  );

  // ---- check with per-host pacing; fold into ok/dead/challenge ----
  let checked = 0;
  let dead = 0;
  let challenge = 0;
  const byRetailer = {};
  const results = await checkQueueWithPacing(planned, {
    check: (url) => checkUrl(fetchImpl, url, { sleep: sleepFn }),
    pauseMs,
    sleep: sleepFn,
  });
  for (const r of results) {
    checked += 1;
    const counts = byRetailer[r.merchant] ?? { checked: 0, dead: 0, challenge: 0 };
    counts.checked += 1;
    if (r.outcome === "dead") {
      counts.dead += 1;
      dead += 1;
      console.log(`DEAD ${r.url}`);
    } else if (r.outcome === "challenge") {
      counts.challenge += 1;
      challenge += 1;
      console.log(`CHALLENGE ${r.url}`);
    }
    byRetailer[r.merchant] = counts;
  }
  for (const [merchant, counts] of Object.entries(byRetailer).sort()) {
    console.log(
      `${merchant}: ${counts.checked} checked, ${counts.dead} dead, ${counts.challenge} challenge`,
    );
  }
  const ok = Math.max(0, checked - dead - challenge);
  console.log(`outcomes: ${ok} ok / ${dead} dead / ${challenge} challenge`);
  return { checked, dead, challenge, ok, byRetailer };
}

async function main() {
  const { checked, dead, challenge, byRetailer } = await runDeadLinkSmoke();

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
