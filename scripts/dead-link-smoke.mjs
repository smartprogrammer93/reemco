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
const UA = "Mozilla/5.0 (compatible; reemco-link-smoke/1.0)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTimeout(url, init) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
}

/** Live snapshot for one fixture query — the site's own converged fan-out. */
async function collectOffers(query) {
  const url = `${BASE}/api/results-followup?q=${encodeURIComponent(query)}`;
  try {
    const res = await fetchTimeout(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      console.log(`WARN ${res.status} ${url}`);
      return [];
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
    return out;
  } catch (e) {
    console.log(`WARN followup fetch failed for "${query}": ${e?.message ?? e}`);
    return [];
  }
}

async function checkUrl(url) {
  try {
    const res = await fetchTimeout(url, { headers: { "user-agent": UA } });
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
