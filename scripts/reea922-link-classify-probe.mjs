/**
 * REEA-922 — dead-link failure-CLASS classifier (diagnostic, not the smoke).
 *
 * Replays scripts/dead-link-smoke.mjs's sampling path (live converged
 * snapshots from /api/results-followup for the fixture queries) and checks
 * each sampled offer URL under THREE checker identities — the pre-REEA-901
 * plain UA, the REEA-901 claimed-Googlebot UA, and a browser UA — following
 * up to 5 hops manually so every failure records its failing hop, status,
 * cf-mitigated header and challenge-body markers. Aggregate-only output
 * (merchant names, URL patterns, response classes); POSTs nothing anywhere.
 *
 * Purpose: separate checker false positives (identity/shape 403/429/503,
 * pacing-induced rate limits) from true dead links (404 under every
 * identity, stable across passes) before the weekly dead-link share is
 * acted on. Re-run after any smoke-identity change to re-baseline.
 *
 * Usage: node scripts/reea922-link-classify-probe.mjs
 *   SMOKE_BASE_URL          base to measure (default https://reemco.vercel.app)
 *   LINK_PROBE_QUERIES      comma-separated fixture queries (default "sony,iphone")
 *   LINK_PROBE_PER_RETAILER max URLs sampled per retailer (default 12)
 *   LINK_PROBE_PAUSE_MS     pause between check requests (default 300)
 *   LINK_PROBE_UA_MODE      "all" (default) | "gbot" | "old" | "browse"
 */
const BASE = (process.env.SMOKE_BASE_URL || "https://reemco.vercel.app").replace(/\/$/, "");
const QUERIES = (process.env.LINK_PROBE_QUERIES || "sony,iphone").split(",").map((q) => q.trim()).filter(Boolean).slice(0, 4);
const PER_RETAILER = Math.max(1, Math.min(20, Number(process.env.LINK_PROBE_PER_RETAILER) || 12));
const PAUSE_MS = Math.max(0, Number(process.env.LINK_PROBE_PAUSE_MS) || 300);
const TIMEOUT_MS = 10_000;
const HOPS = 5;

const UAS = {
  old: "Mozilla/5.0 (compatible; reemco-link-smoke/1.0)",
  gbot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  browse: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
};
const identities = process.env.LINK_PROBE_UA_MODE && UAS[process.env.LINK_PROBE_UA_MODE]
  ? [process.env.LINK_PROBE_UA_MODE]
  : Object.keys(UAS);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function collectOffers(query) {
  try {
    const res = await fetch(`${BASE}/api/results-followup?q=${encodeURIComponent(query)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const snap = await res.json();
    const out = [];
    for (const p of Array.isArray(snap?.products) ? snap.products : []) {
      for (const o of Array.isArray(p?.offers) ? p.offers : []) {
        if (typeof o?.url === "string" && typeof o?.merchant === "string" && /^https?:\/\//.test(o.url)) {
          out.push({ merchant: o.merchant, url: o.url });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Manual-redirect check that records the full hop chain and failure class. */
async function checkWithHops(url, ua) {
  const hops = [];
  let current = url;
  for (let i = 0; i < HOPS; i++) {
    let res;
    try {
      res = await fetch(current, {
        headers: { "user-agent": ua, accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      hops.push({ hop: i, url: current, error: `${e?.name ?? "error"}: ${e?.message ?? e}`.slice(0, 160) });
      return { hops, alive: false, errorClass: "network" };
    }
    const hop = {
      hop: i,
      url: current,
      status: res.status,
      server: res.headers.get("server") ?? undefined,
      cfMitigated: res.headers.get("cf-mitigated") ?? undefined,
    };
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      hop.location = loc.slice(0, 200);
      hops.push(hop);
      current = new URL(loc, current).toString();
      continue;
    }
    if (res.status >= 400) {
      try {
        const head = (await res.text()).slice(0, 2000).toLowerCase();
        hop.bodyMarkers = ["just a moment", "attention required", "challenge", "enable javascript", "access denied", "captcha", "blocked"]
          .filter((m) => head.includes(m));
      } catch {}
    }
    hops.push(hop);
    return { hops, alive: res.status >= 200 && res.status < 400, errorClass: res.status >= 400 ? `http-${res.status}` : "ok" };
  }
  return { hops, alive: false, errorClass: "redirect-loop" };
}

const perRetailer = new Map();
const seen = new Set();
for (const q of QUERIES) {
  for (const o of await collectOffers(q)) {
    if (seen.has(o.url)) continue;
    seen.add(o.url);
    const bucket = perRetailer.get(o.merchant) ?? [];
    if (bucket.length < PER_RETAILER) bucket.push(o.url);
    perRetailer.set(o.merchant, bucket);
  }
}

const results = {};
for (const [merchant, urls] of [...perRetailer.entries()].sort()) {
  results[merchant] = [];
  for (const url of urls) {
    const checks = {};
    for (const name of identities) {
      checks[name] = await checkWithHops(url, UAS[name]);
      await sleep(PAUSE_MS);
    }
    results[merchant].push({ url, checks });
    const flag = identities.map((n) => (checks[n].alive ? "." : "X")).join("");
    console.error(`[${merchant}] ${flag} ${url}`);
  }
}

// Class summary: a URL is TRUE-DEAD only when every identity fails with a
// non-challenge class; identity/pacing failures show per-identity splits.
const summary = {};
for (const [merchant, rows] of Object.entries(results)) {
  const s = { sampled: rows.length, trueDead: 0, identityOnly: 0, challenge: 0, alive: 0 };
  for (const row of rows) {
    const alive = identities.filter((n) => row.checks[n].alive).length;
    if (alive === identities.length) s.alive += 1;
    else if (identities.some((n) => row.checks[n].hops?.some((h) => h.cfMitigated === "challenge" || row.checks[n].errorClass === "http-429"))) s.challenge += 1;
    else if (alive > 0) s.identityOnly += 1;
    else s.trueDead += 1;
  }
  summary[merchant] = s;
}
console.log(JSON.stringify({ sampledAt: new Date().toISOString(), base: BASE, summary, results }, null, 1));
