/**
 * REEA-807 — dead-link smoke over LIVE offer URLs, recorded as aggregate
 * counters (no PII, nothing per-URL stored).
 *
 * Pulls the converged live snapshot for a couple of fixture queries from this
 * site's OWN results feed (/api/results-followup — the same single live
 * fan-out the results page runs, never a bundled catalog), samples a bounded
 * set of outbound offer URLs per retailer, checks them politely (one request
 * per URL, small inter-check pause, per-URL timeout), and POSTs the aggregate
 * outcome to /api/metrics/link-smoke so it lands in the weekly PM snapshot.
 *
 * Usage: node scripts/dead-link-smoke.mjs
 *   SMOKE_BASE_URL   base to measure (default https://reemco.vercel.app)
 *   LINK_SMOKE_QUERIES  comma-separated fixture queries (default "sony,iphone")
 *   LINK_SMOKE_PER_RETAILER  max URLs checked per retailer (default 8)
 *   LINK_SMOKE_PAUSE_MS      pause between URL checks (default 300)
 *
 * Never throws: exit 0 with a printed verdict, exit 1 only when the ingest
 * POST itself failed (the counters did not land).
 */
const BASE = (process.env.SMOKE_BASE_URL || "https://reemco.vercel.app").replace(/\/$/, "");
const QUERIES = (process.env.LINK_SMOKE_QUERIES || "sony,iphone")
  .split(",")
  .map((q) => q.trim())
  .filter(Boolean)
  .slice(0, 4);
const PER_RETAILER = Math.max(1, Math.min(20, Number(process.env.LINK_SMOKE_PER_RETAILER) || 8));
const PAUSE_MS = Math.max(0, Number(process.env.LINK_SMOKE_PAUSE_MS) || 300);
const FETCH_TIMEOUT_MS = 10_000;
// REEA-901 + REEA-922 — the liveness check presents a PER-HOST identity,
// documented here and versioned with the code. Policy (REEA-922 root cause,
// CEO-confirmed fix sequence step 1): every identity in this table mirrors
// the LEAD request identity the matching live adapter actually sends — the
// smoke must measure the links the way our own traffic reaches them, never
// invent a new checker shape. NO SILENT SWAPS: any change here re-baselines
// the weekly dead-link number (run scripts/reea922-link-classify-probe.mjs
// before/after) and says so in the change's commit message.
//
// - DEFAULT "verified-crawler": the claimed-crawler UA VERIFIED_BOT_HEADERS
//   leads with (search-fallback.ts). Measured 2026-09-13 (REEA-901):
//   CF-fronted storefronts (Next Store measured, Lulu the same family)
//   answer plain/Mozilla UAs with the HTTP 403 challenge shell on product
//   URLs a real browser passes interactively — W37 recorded Next Store
//   3 checked / 3 "dead" while every sampled URL answered 200 to this
//   identity. A non-interactive 403 from the zone's bot rule is not a dead
//   link; measuring it as one poisons the retailer's dead-link share.
// - amazon.eg "amazon-eg-adapter-lead": `user-agent: Mozilla/5.0` with
//   `accept-encoding` pinned EMPTY — byte-for-byte the lead hop its adapter
//   sends (REEA-397 pin in live-search.ts). Measured 2026-09-14 (REEA-922
//   diagnosis): amazon.eg's edge answers a deterministic 503 apology page to
//   the claimed-crawler UA when undici injects
//   `accept-encoding: br, gzip, deflate` (8/8 sampled /dp URLs), while the
//   adapter-shaped request answers 200 — the W37 Amazon.eg 15/49 "dead"
//   share was checker identity, not rot.
const DEFAULT_IDENTITY = {
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
];

function identityFor(url) {
  try {
    const host = new URL(url).hostname;
    return HOST_IDENTITIES.find((e) => e.match.test(host)) ?? DEFAULT_IDENTITY;
  } catch {
    return DEFAULT_IDENTITY;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTimeout(url, init) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
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
      const res = await fetchTimeout(url, { headers: { accept: "application/json" } });
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

async function checkUrl(url) {
  try {
    const res = await fetchTimeout(url, { headers: identityFor(url).headers });
    return res.status >= 200 && res.status < 400;
  } catch {
    return false; // unreachable / timeout counts as dead
  }
}

// ---- collect a bounded, deduped sample per retailer ----
const perRetailer = new Map(); // merchant -> { checked, dead }
let checked = 0;
let dead = 0;

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

for (const [merchant, bucket] of [...perRetailer.entries()].sort()) {
  const counts = { checked: 0, dead: 0 };
  for (const url of bucket.queue) {
    const alive = await checkUrl(url);
    counts.checked += 1;
    if (!alive) {
      counts.dead += 1;
      console.log(`DEAD ${url}`);
    }
    checked += 1;
    if (!alive) dead += 1;
    await sleep(PAUSE_MS);
  }
  perRetailer.set(merchant, counts);
  console.log(`${merchant}: ${counts.checked} checked, ${counts.dead} dead`);
}

// ---- record the aggregate outcome ----
const byRetailer = {};
for (const [merchant, c] of perRetailer) byRetailer[merchant] = { checked: c.checked, dead: c.dead };

const ingest = `${BASE}/api/metrics/link-smoke`;
try {
  const res = await fetch(ingest, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ checked, dead, by_retailer: byRetailer }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.ok) {
    console.log(`LINK SMOKE PASSED — recorded ${checked} checked / ${dead} dead to ${ingest}`);
  } else {
    console.error(`LINK SMOKE INGEST FAILED — ${res.status} from ${ingest}`);
    process.exit(1);
  }
} catch (e) {
  console.error(`LINK SMOKE INGEST FAILED — ${e?.message ?? e} (${ingest})`);
  process.exit(1);
}
