/**
 * REEA-1221 AC-2 canary — the day-by-day lane failure-share reading.
 *
 * AC-2 asks for "a failure share <20% across 3 consecutive days of canary runs",
 * so somebody has to run the SAME panel every day and record what each lane did.
 * This script is that instrument: it reads the served stamp first (a QA parity
 * rule — never measure a stale head), forces cold fan-outs on the ticket's fixed
 * 12-query panel, and prints one table with the per-lane failure share, the
 * in-market offers each lane produced, the AC-3 cluster comparison and the AC-6
 * comparison-depth ratio.
 *
 * It only measures. It never decides: a lane above 20% is reported, not retired
 * (the keep-at-it rule on the ticket).
 *
 * Usage:
 *   BASE_URL=https://ns539626.ip-144-217-72.net node scripts/reea1221-canary.mjs
 *   BASE_URL=... node scripts/reea1221-canary.mjs --json   # machine-readable
 *
 * Exit 0 = measured. Exit 1 = the served head could not be read.
 */
import { writeFileSync } from "node:fs";

const BASE = (process.env.BASE_URL || "https://ns539626.ip-144-217-72.net").replace(/\/$/, "");
const AS_JSON = process.argv.includes("--json");
const TIMEOUT_MS = 150_000;

/** The ticket's fixed panel, verbatim. */
const PANEL = [
  "washing machine",
  "laptop",
  "headphones",
  "panadol",
  "iphone 17 pro",
  "ps5",
  "dyson",
  "air fryer",
  "nintendo switch 2",
  "cucumber",
  "galaxy z fold 7",
  "samsung galaxy s25 ultra",
];

/** AC-3's partial cluster and its W48 baseline share. */
const CLUSTER = {
  "Amazon.eg": 57,
  Blink: 50,
  "Zayoom": 30,
  Astore: 30,
  Wibi: 29,
  Switch: 30,
  "Quadra Stores": 29,
};

/** AC-2's repaired lanes (the seven the ticket names, plus the two the board added). */
const REPAIRED = [
  "Lulu Hypermarket",
  "Ounass",
  "BinSina",
  "Yousifi",
  "Alghanim Electronics",
  "Aster Pharmacy",
  "Sultan Center",
];

const stamp = async () => {
  const res = await fetch(`${BASE}/__commit.txt`, { signal: AbortSignal.timeout(20_000) });
  return res.ok ? (await res.text()).trim() : "";
};

const kuwaitMarket = (offer) =>
  (offer.market ?? (offer.currency === "SAR" ? "SA" : offer.currency === "EGP" ? "EG" : "KW")) === "KW";

/** The ticket's own comparison rule (weekly-metric depth). */
const depthEligible = (offer) => {
  const reason = offer.sanity?.reason ?? "";
  if (reason === "currency_mis_map" || reason === "price_unavailable") return false;
  const ratio = offer.sanity?.ratioToMedian ?? 1;
  if (reason === "outlier_low" && ratio < 0.1) return false;
  if ((offer.sanity?.status ?? "") === "ok" && ratio < 0.1) return false;
  return kuwaitMarket(offer);
};

const cardMerchants = (product, eligible) => {
  const merchants = new Set();
  for (const offer of product.offers ?? []) {
    if (!kuwaitMarket(offer)) continue;
    if (eligible === "card") {
      const reason = offer.sanity?.reason ?? "";
      if (reason === "currency_mis_map" || reason === "price_unavailable") continue;
      if (reason === "outlier_low" && (offer.sanity?.ratioToMedian ?? 0) < 0.1) continue;
    } else if (!depthEligible(offer)) continue;
    merchants.add(offer.merchant);
  }
  return merchants.size;
};

const main = async () => {
  const head = await stamp();
  if (!head) {
    console.error("CANARY: could not read /__commit.txt — refusing to measure an unknown head");
    process.exit(1);
  }

  const lanes = new Map();
  const rows = [];
  for (const query of PANEL) {
    const url = `${BASE}/api/results-followup?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { cookie: "rc_refresh=1" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`CANARY: ${query} answered HTTP ${res.status}`);
      continue;
    }
    // The follow-up route answers `null` when the fan-out had nothing to settle
    // for that query; that is a measurement gap, not a lane verdict, so it is
    // reported and skipped rather than crashing the run.
    const payload = await res.json();
    if (!payload || typeof payload !== "object") {
      console.error(`CANARY: ${query} answered no payload — skipped`);
      continue;
    }
    for (const note of payload.notes ?? []) {
      const lane = lanes.get(note.merchant) ?? { attempts: 0, failures: 0, offers: 0, errors: new Set() };
      lane.attempts += 1;
      if (note.error) {
        lane.failures += 1;
        lane.errors.add(note.error.slice(0, 90));
      }
      lanes.set(note.merchant, lane);
    }
    for (const product of payload.products ?? []) {
      for (const offer of product.offers ?? []) {
        const lane = lanes.get(offer.merchant);
        if (lane) lane.offers += 1;
      }
    }
    rows.push({
      query,
      cardCards: (payload.products ?? []).filter((p) => cardMerchants(p, "card") > 0).length,
      cardMulti: (payload.products ?? []).filter((p) => cardMerchants(p, "card") >= 2).length,
      depthCards: (payload.products ?? []).filter((p) => cardMerchants(p, "depth") > 0).length,
      depthMulti: (payload.products ?? []).filter((p) => cardMerchants(p, "depth") >= 2).length,
    });
  }

  const table = [...lanes.entries()]
    .map(([merchant, lane]) => ({
      merchant,
      attempts: lane.attempts,
      failures: lane.failures,
      share: lane.attempts > 0 ? Math.floor((lane.failures * 100) / lane.attempts) : 0,
      offers: lane.offers,
      error: [...lane.errors][0] ?? "",
    }))
    .sort((a, b) => a.share - b.share || b.offers - a.offers);

  const sum = (key) => rows.reduce((n, r) => n + r[key], 0);
  const cardCards = sum("cardCards");
  const cardMulti = sum("cardMulti");
  const depthCards = sum("depthCards");
  const depthMulti = sum("depthMulti");

  const result = {
    servedHead: head,
    measuredAt: new Date().toISOString(),
    panel: PANEL.length,
    lanes: table,
    ac2: REPAIRED.map((merchant) => ({
      merchant,
      ...(table.find((l) => l.merchant === merchant) ?? { attempts: 0, failures: 0, share: 0, offers: 0 }),
      below20: (table.find((l) => l.merchant === merchant)?.share ?? 0) < 20,
    })),
    ac3: Object.entries(CLUSTER).map(([merchant, baseline]) => {
      const lane = table.find((l) => l.merchant === merchant);
      return { merchant, baseline, share: lane?.share ?? 0, halved: (lane?.share ?? 0) <= baseline / 2 };
    }),
    ac6: {
      cardRule: cardCards > 0 ? Math.floor((cardMulti * 100) / cardCards) : 0,
      depthRule: depthCards > 0 ? Math.floor((depthMulti * 100) / depthCards) : 0,
    },
  };

  if (AS_JSON) {
    writeFileSync("/tmp/reea1221-canary.json", JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
    return;
  }

  console.log(`CANARY: served=${head} panel=${PANEL.length} at=${result.measuredAt}`);
  console.log("");
  console.log("lane | attempts | failures | share | offers | first error");
  for (const lane of table) {
    console.log(
      `${lane.merchant} | ${lane.attempts} | ${lane.failures} | ${lane.share}% | ${lane.offers} | ${lane.error}`,
    );
  }
  console.log("");
  console.log("AC-2 (repaired lanes, gate <20%):");
  for (const lane of result.ac2) {
    console.log(`  ${lane.merchant}: ${lane.share}% ${lane.below20 ? "PASS" : "ABOVE GATE"} (offers ${lane.offers})`);
  }
  console.log("");
  console.log("AC-3 (cluster, must be at least halved against W48):");
  for (const lane of result.ac3) {
    console.log(`  ${lane.merchant}: ${lane.share}% vs baseline ${lane.baseline}% ${lane.halved ? "HALVED" : "NOT HALVED"}`);
  }
  console.log("");
  console.log(`AC-6: card rule ${result.ac6.cardRule}% | weekly-metric rule ${result.ac6.depthRule}% (gate 25%)`);
};

await main();
