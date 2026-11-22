#!/usr/bin/env node
/**
 * REEA-1051 — self-host readiness: live adapter probe from a deployed runtime.
 *
 * The egress IP is part of the adapter's contract (retailer bot rules answer
 * differently per IP reputation), so this probe must be pointed at the host
 * whose egress we are grading. It talks to the app's own converged live-feed
 * endpoint (`/api/results-followup?q=…`), which runs the real per-retailer
 * collectors server-side and returns the run's own per-merchant notes.
 *
 * Usage:
 *   node scripts/reea1051-adapter-probe.mjs [baseUrl]
 *   BASE_URL=https://ns539626.ip-144-217-72.net node scripts/reea1051-adapter-probe.mjs
 *
 * Output: one JSON line per query (query, elapsed, notes, offers-per-merchant,
 * first/last collectedAt offset per merchant) plus a compact table on stderr.
 * Exit code 0 always — this is an evidence collector, not a gate.
 */
import { writeFileSync } from "node:fs";

const BASE = (process.argv[2] || process.env.BASE_URL || "https://ns539626.ip-144-217-72.net").replace(/\/$/, "");

// EN + AR samples across the live lanes: electronics (Xcite/Jarir/Eureka),
// grocery/pharmacy (Sultan Center/Aster/Nahdi/BinSina), and a Kuwait
// marketplace query (Alghanim/Blink/Next Store/Zayoom/Astore/Wibi).
const QUERIES = [
  { q: "iphone 15", lang: "EN", lane: "electronics" },
  { q: "sony wh-1000xm5", lang: "EN", lane: "electronics" },
  { q: "cucumber", lang: "EN", lane: "grocery" },
  { q: "آيفون 15", lang: "AR", lane: "electronics" },
  { q: "سماعات سوني", lang: "AR", lane: "electronics" },
  { q: "خيار", lang: "AR", lane: "grocery" },
];

const out = [];
for (const sample of QUERIES) {
  const started = Date.now();
  let status = 0;
  let payload = null;
  try {
    const res = await fetch(`${BASE}/api/results-followup?q=${encodeURIComponent(sample.q)}`, {
      signal: AbortSignal.timeout(60_000),
    });
    status = res.status;
    const text = await res.text();
    payload = text ? JSON.parse(text) : null;
  } catch (err) {
    payload = { error: String(err) };
  }
  const elapsed = Date.now() - started;
  const offers = [];
  const offsets = new Map();
  for (const p of payload?.products ?? []) {
    for (const o of p.offers ?? []) {
      offers.push(o.merchant);
      const at = Date.parse(o.collectedAt ?? "");
      if (!Number.isNaN(at)) {
        const cur = offsets.get(o.merchant) ?? { first: Infinity, last: -Infinity };
        cur.first = Math.min(cur.first, at - started);
        cur.last = Math.max(cur.last, at - started);
        offsets.set(o.merchant, cur);
      }
    }
  }
  const counts = offers.reduce((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
  const record = {
    query: sample.q,
    lang: sample.lang,
    lane: sample.lane,
    httpStatus: status,
    elapsedMs: elapsed,
    settled: payload?.settled ?? null,
    attemptedQueries: payload?.attemptedQueries ?? null,
    products: payload?.products?.length ?? 0,
    offersByMerchant: counts,
    notes: (payload?.notes ?? []).map((n) => ({
      merchant: n.merchant,
      hits: n.hits,
      coupons: n.coupons ?? 0,
      error: n.error ?? null,
      firstOfferMs: offsets.get(n.merchant)?.first ?? null,
      lastOfferMs: offsets.get(n.merchant)?.last ?? null,
    })),
    error: payload?.error ?? null,
  };
  out.push(record);
  console.error(`\n### ${sample.lang} "${sample.q}" (${sample.lane}) http=${status} ${elapsed}ms products=${record.products}`);
  for (const n of record.notes) {
    const lat = n.firstOfferMs == null ? "-" : `${n.firstOfferMs}ms`;
    console.error(`${n.merchant.padEnd(22)} hits=${String(n.hits).padStart(3)} first=${lat.padEnd(8)} err=${n.error ?? "-"}`);
  }
}

const target = "reea1051-adapter-probe.json";
writeFileSync(target, JSON.stringify({ base: BASE, probedAt: new Date().toISOString(), samples: out }, null, 2));
console.error(`\nwrote ${target}`);
