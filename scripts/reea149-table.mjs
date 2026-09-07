// REEA-149 — REEA-134 per-query table method against the deployed site.
// One row per query: query string, distinct merchants whose offers actually
// rendered in the served HTML, whether >=1 offer appeared, and the newest/
// oldest scrapedAt ages from the live payload (AC4: within 24 h). Usage:
//   BASE=https://reemco.vercel.app node scripts/reea149-table.mjs
const BASE = (process.env.BASE || "https://reemco.vercel.app").replace(/\/$/, "");
const QUERIES = [
  "WH-1000XM6",
  "AirPods Pro",
  "JBL Tune 520BT",
  "lg gram",
  "MacBook Air",
  "Lenovo IdeaPad Slim 3",
  "samsung", // REEA-141 regression row (AC6)
];
const KNOWN = ["Xcite", "Jarir", "Eureka", "Sultan Center", "Amazon.eg", "Blink"];

let zeroRows = 0;
const rows = [];
for (const q of QUERIES) {
  const res = await fetch(`${BASE}/results?q=${encodeURIComponent(q)}`, {
    headers: { accept: "text/html", "accept-language": "en" },
  });
  const html = await res.text();
  // Merchets render as chip text nodes inside offer rows.
  const merchants = KNOWN.filter((m) => html.includes(`>${m}<`));
  const cards = (html.match(/Prices and availability by retailer/g) || []).length;
  // Flight payloads escape quotes: scrapedAt":"<iso> — accept both forms.
  const stamps = [...html.matchAll(/scrapedAt\\?":\\?"([^"\\]+)/g)].map((m) => Date.parse(m[1]));
  const now = Date.now();
  const agesH = stamps.map((t) => (now - t) / 3_600_000);
  const maxAgeH = agesH.length ? Math.max(...agesH) : NaN;
  const offers = cards >= 1 && merchants.length >= 1;
  if (!offers) zeroRows++;
  rows.push({ q, merchants: merchants.join(", "), offers, maxAgeH });
  console.log(
    `ROW | ${q} | ${merchants.join(", ") || "(none)"} | offers>=1: ${offers} | cards: ${cards} | maxAgeH: ${agesH.length ? maxAgeH.toFixed(3) : "no-stamp"}`,
  );
}
const rate = zeroRows / QUERIES.length;
console.log(`ZERO-RATE | ${zeroRows}/${QUERIES.length} = ${(rate * 100).toFixed(1)}% (AC2 <=10%)`);
process.exit(rate <= 0.1 ? 0 : 1);
