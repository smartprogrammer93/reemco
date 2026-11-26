/**
 * REEA-1207 rev-2 — AC 7B-2b probe: the five pinned identity pairs.
 *
 * AC 7B-2b: "the five pinned identity pairs each render as ONE card carrying
 * both retailers, EN+AR". The pairs are the cross-retailer identity fixes this
 * ticket shipped (Sony XM5, Sony CH720N, Switch 2 console, Panadol pack, Dyson
 * Airwrap). Identity is pinned at the unit level by
 * src/lib/collect/reea1207-model-identity.test.ts; this probe checks the
 * RENDERED shelf, because a pair can only appear when both of its lanes answer
 * on the same serve (lane composition oscillates — see the ticket's risk §7).
 *
 * No arguments, no browser. For each pair and locale it reads the served
 * results page and looks for a single card whose offers region carries BOTH
 * merchant names (the related-alternatives band is cut off first, so a name
 * that only appears as an alternative cannot count). Each pair/locale gets up
 * to ATTEMPTS serves because the fan-out is per-serve.
 *
 * Exit code is non-zero only when the probe could not measure (stamp or page
 * fetch failed). A pair that did not appear is reported, never thrown — the
 * gate is judged from the printed table.
 *
 * Usage:
 *   node scripts/reea1207-identity-pairs.mjs
 *   BASE_URL=http://localhost:3000 node scripts/reea1207-identity-pairs.mjs
 */
import { writeFileSync } from "node:fs";

const BASE = (process.env.BASE_URL || "https://ns539626.ip-144-217-72.net").replace(/\/$/, "");
const OUT = process.env.OUT || "/tmp/reea1207-identity-pairs.json";
const LOCALES = ["en", "ar"];
const ATTEMPTS = 4;
const GAP_MS = 900;

/** The five pinned pairs, with the query that carries them. */
const PAIRS = [
  { id: "sony-wh1000xm5", query: "headphones", a: "Blink", b: "Xcite" },
  { id: "sony-whch720n", query: "headphones", a: "Jarir", b: "Blink" },
  { id: "switch2-console", query: "nintendo switch 2", a: "Blink", b: "Eureka" },
  { id: "panadol-pack", query: "panadol", a: "Danube Home", b: "BinSina" },
  { id: "dyson-airwrap", query: "dyson", a: "Eureka", b: "Wibi" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(90_000), cache: "no-store" });
  return { status: res.status, body: await res.text() };
}

async function readStamp() {
  const commit = await fetchText(`${BASE}/__commit.txt`, {});
  const health = await fetchText(`${BASE}/api/health`, { accept: "application/json" });
  let healthJson = null;
  try {
    healthJson = JSON.parse(health.body);
  } catch {
    healthJson = { raw: health.body.slice(0, 200) };
  }
  return { commitHttp: commit.status, commit: commit.body.trim(), healthHttp: health.status, health: healthJson };
}

/** True when one rendered card's offers region carries both merchant names. */
function cardCarriesBoth(html, a, b) {
  const parts = html.split(/<article\b/).slice(1);
  for (const part of parts) {
    // The related-alternatives band follows the card's offers; cut it off so a
    // merchant that only appears as an alternative cannot count.
    const cut = part.split(/aria-label="(Alternatives|البدائل)"/)[0];
    const text = cut.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    if (text.includes(a) && text.includes(b)) return true;
  }
  return false;
}

async function main() {
  const stamp = await readStamp();
  console.log(
    `stamp: /__commit.txt HTTP ${stamp.commitHttp} → ${stamp.commit}; ` +
      `/api/health HTTP ${stamp.healthHttp} → ${JSON.stringify(stamp.health)}`,
  );
  if (stamp.commitHttp !== 200) {
    throw new Error(`commit stamp unreadable (HTTP ${stamp.commitHttp})`);
  }

  const rows = [];
  for (const locale of LOCALES) {
    for (const pair of PAIRS) {
      let found = false;
      let serves = 0;
      for (let attempt = 0; attempt < ATTEMPTS && !found; attempt += 1) {
        const { status, body } = await fetchText(
          `${BASE}/results?q=${encodeURIComponent(pair.query)}`,
          { cookie: `rc_locale=${locale}`, "accept-language": locale === "ar" ? "ar" : "en" },
        );
        if (status !== 200) {
          await sleep(GAP_MS);
          continue;
        }
        serves += 1;
        found = cardCarriesBoth(body, pair.a, pair.b);
        if (!found) await sleep(GAP_MS);
      }
      rows.push({ id: pair.id, locale, query: pair.query, pair: `${pair.a}+${pair.b}`, serves, oneCard: found });
      console.log(`  ${pair.id} [${locale}]: ${found ? "ONE CARD carrying both retailers" : "not on these serves"} (${serves} serves)`);
    }
  }

  const missed = rows.filter((r) => !r.oneCard);
  console.log(
    `\nAC 7B-2b: ${rows.length - missed.length}/${rows.length} pair-locale checks found one card carrying both retailers` +
      (missed.length ? `; missing: ${missed.map((r) => `${r.id}/${r.locale}`).join(", ")}` : ""),
  );
  writeFileSync(OUT, `${JSON.stringify({ ticket: "REEA-1207", base: BASE, stamp, attemptsPerPair: ATTEMPTS, rows }, null, 2)}\n`);
  console.log(`full payload: ${OUT}`);
}

main().catch((err) => {
  console.error(`probe failed: ${err.message}`);
  process.exitCode = 1;
});
