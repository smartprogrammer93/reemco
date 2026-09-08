/**
 * REEA-274 — time-to-first-offer / time-to-full-results probe for the
 * scheduled live-site smoke check (REEA-58 lineage).
 *
 * Measures, per run, the fixed REEA-255 benchmark query set (20 queries:
 * smartphones / headphones / appliances + 4 typo rows) against the PRODUCTION
 * results page and reports nearest-rank p50/p95 for:
 *   - time-to-first-offer: request start -> bytes of the first real offer
 *     card (<article class="result-card"> without the aria-hidden skeleton
 *     attribute) arrive in the streamed response body. This is the shopper's
 *     moment of truth: press search -> see first real price.
 *   - time-to-full-results: request start -> whole document body downloaded
 *     (all retailers flushed into the stream).
 *
 * Method matches the REEA-255/REEA-267 curl probes: plain HTTPS GETs from a
 * clean client, chunks read incrementally so mid-stream flushes are visible.
 * Measurement only — no caching, no bundled catalog; every run hits live
 * per-retailer data (live-data policy honored).
 *
 * Grading (report-only initially): GREEN when first-offer p50 <= 1500ms AND
 * p95 <= 3000ms; otherwise RED. Full-results is informational context.
 * The probe NEVER throws — timings must not flap the functional smoke result.
 *
 * Usage: node scripts/smoke-timings.mjs            (prints the report)
 *        import { measureResultsTimings } ...      (used by smoke-check.mjs)
 */
const BASE = (process.env.SMOKE_BASE_URL || "https://reemco.vercel.app").replace(/\/$/, "");

// Fixed set from the REEA-255 benchmark doc (key: benchmark) — 16 normal rows
// + 4 typo rows, verbatim. Do not edit without re-baselining REEA-255.
const QUERIES = [
  "iPhone 17 Pro",
  "iPhone 17 Pro Max",
  "Samsung Galaxy S25 Ultra",
  "Samsung Galaxy S25",
  "Xiaomi 15",
  "Redmi Note",
  "Sony WH-1000XM6",
  "Sony WF",
  "AirPods Pro 3",
  "AirPods 4",
  "JBL Tune",
  "Samsung washing machine",
  "LG refrigerator",
  "Whirlpool microwave",
  "Philips air fryer",
  "Nutribullet",
  "iphon 17 pro",
  "reciever",
  "samsng s25",
  "whirpool microwave",
];

const THRESHOLD_P50_MS = 1500;
const THRESHOLD_P95_MS = 3000;

// First real offer card: the streaming shell emits aria-hidden skeleton
// placeholders first; the real offer is the bare result-card article
// (same distinction step 2 of smoke-check.mjs makes in the DOM).
const FIRST_OFFER_RE = /<article class="result-card"(?! aria-hidden)/;

const HEADERS = {
  accept: "text/html,application/xhtml+xml",
  "accept-language": "en",
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
};

/** One cold-client measurement for one query. Retries once on transport error. */
async function probeQuery(base, query) {
  let lastErr = "no attempt";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
    try {
      const t0 = Date.now();
      const res = await fetch(`${base}/results?q=${encodeURIComponent(query)}`, {
        headers: HEADERS,
        redirect: "follow",
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok || !res.body) {
        lastErr = `HTTP ${res.status}`;
        continue;
      }
      let firstOfferMs = null;
      let seen = "";
      const dec = new TextDecoder();
      for await (const chunk of res.body) {
        seen += dec.decode(chunk, { stream: true });
        if (firstOfferMs === null && FIRST_OFFER_RE.test(seen)) firstOfferMs = Date.now() - t0;
      }
      seen += dec.decode();
      if (firstOfferMs === null && FIRST_OFFER_RE.test(seen)) firstOfferMs = Date.now() - t0;
      const fullMs = Date.now() - t0;
      if (firstOfferMs === null) {
        lastErr = "no real result-card rendered within the served document";
        continue;
      }
      return { query, firstOfferMs, fullMs };
    } catch (e) {
      lastErr = `ERR ${e?.cause?.code ?? e?.message ?? "unreachable"}`;
    }
  }
  return { query, firstOfferMs: null, fullMs: null, error: lastErr };
}

/** Nearest-rank percentile, same method as scripts/qa-verify.mjs RT AC-6. */
function percentile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

/** Runs the fixed set sequentially (cold-client timing would overlap in parallel). */
export async function measureResultsTimings(base = BASE) {
  const lines = [];
  const rows = [];
  for (const q of QUERIES) rows.push(await probeQuery(base, q));

  const tfo = rows.map((r) => r.firstOfferMs).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const full = rows.map((r) => r.fullMs).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  for (const r of rows) {
    lines.push(
      `TIMING | ${r.query} | first-offer ${r.firstOfferMs ?? "-"}ms | full-results ${r.fullMs ?? "-"}ms${r.error ? ` (${r.error})` : ""}`,
    );
  }
  if (!tfo.length || !full.length) {
    lines.push(`TIMINGS skipped — ${rows.length - tfo.length}/${rows.length} query probe(s) failed.`);
    return lines;
  }
  const tfoP50 = percentile(tfo, 0.5);
  const tfoP95 = percentile(tfo, 0.95);
  const fullP50 = percentile(full, 0.5);
  const fullP95 = percentile(full, 0.95);
  const green = tfoP50 <= THRESHOLD_P50_MS && tfoP95 <= THRESHOLD_P95_MS;
  lines.push(
    `TIMINGS SUMMARY | n=${tfo.length} queries | first-offer p50=${tfoP50}ms p95=${tfoP95}ms | full-results p50=${fullP50}ms p95=${fullP95}ms`,
  );
  lines.push(
    `TIMINGS GRADE | first-offer vs p50<=${THRESHOLD_P50_MS}ms p95<=${THRESHOLD_P95_MS}ms -> ${green ? "GREEN" : "RED"} (report-only; P0 in REEA-267 must turn it green)`,
  );
  return lines;
}

// Direct-invocation mode (also usable standalone for one-off baselines).
if (process.argv[1] && process.argv[1].endsWith("smoke-timings.mjs")) {
  for (const line of await measureResultsTimings()) console.log(line);
}
