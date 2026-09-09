/** REEA-408 — before/after hit-count probe on the fixed query set against
 *  the deployed site. Runs the 4 fixed queries per round (parallel within a
 *  round, rounds sequential), reads the FINAL coverage-notes array from the
 *  streamed /results document (the same notes the coverage line renders),
 *  and prints per-round per-merchant hits + errors, then an aggregate
 *  table: rounds with hits>0 per merchant per query. Adapted from
 *  reaa397-amazon-counts.mjs (same escape-unwrap + last-array rules).
 *
 *  Usage: node scripts/reaa408-counts.mjs [rounds] [--quiet]
 */
const BASE = "https://reemco.vercel.app";
const QUERIES = ["iPhone 17 Pro", "WH-1000XM6", "أرز بسمتي", "لابتوب ديل"];
const HEADERS = {
  accept: "text/html,application/xhtml+xml",
  "accept-language": "en",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
};

function notes(html) {
  let s = html;
  for (let i = 0; i < 4; i++) {
    const t = s.replace(/\\"/g, '"');
    if (t === s) break;
    s = t;
  }
  const out = [];
  const re = /"notes":\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    try {
      out.push(JSON.parse(`[${m[1]}]`));
    } catch {}
  }
  return out;
}

async function one(q) {
  const t0 = Date.now();
  try {
    const r = await fetch(
      `${BASE}/results?q=${encodeURIComponent(q)}`,
      { headers: HEADERS, signal: AbortSignal.timeout(35000) },
    );
    let h = "";
    const d = new TextDecoder();
    for await (const c of r.body) h += d.decode(c, { stream: true });
    h += d.decode();
    const a = notes(h);
    const f = a[a.length - 1] ?? [];
    return { q, ms: Date.now() - t0, notes: f, snaps: a.length };
  } catch (e) {
    return { q, ms: Date.now() - t0, notes: [], fetchError: String(e?.cause?.code ?? e?.message ?? e) };
  }
}

const rounds = Number(process.argv[2] || process.argv.find((a) => /^\d+$/.test(a)) || 5);
const quiet = process.argv.includes("--quiet");
const merchants = [];
const seen = new Set();
/** counts[merchant][query] = number of rounds with hits>0 */
const counts = {};
const errors = {};

for (let round = 1; round <= rounds; round++) {
  const rows = await Promise.all(QUERIES.map(one));
  for (const r of rows) {
    for (const n of r.notes) {
      if (!seen.has(n.merchant)) {
        seen.add(n.merchant);
        merchants.push(n.merchant);
      }
      counts[n.merchant] ??= {};
      counts[n.merchant][r.q] ??= 0;
      if ((n.hits ?? 0) > 0) counts[n.merchant][r.q]++;
      if (n.error) {
        errors[n.merchant] ??= {};
        const key = `${n.error}`;
        errors[n.merchant][key] = (errors[n.merchant][key] ?? 0) + 1;
      }
    }
    if (!quiet) {
      const brief = r.notes
        .map((n) => `${n.merchant}:${n.hits}${n.error ? `(${n.error})` : ""}`)
        .join(" ");
      console.log(
        `R${round} | ${r.q} | ${r.ms}ms${r.fetchError ? ` FETCH_ERR ${r.fetchError}` : ""} | ${brief}`,
      );
    }
  }
}

console.log(`\nAggregate over ${rounds} rounds (rounds with hits>0, max ${rounds}):`);
console.log("merchant".padEnd(18) + QUERIES.map((q) => q.slice(0, 12).padStart(13)).join(""));
for (const m of merchants) {
  const row = QUERIES.map((q) => String(counts[m]?.[q] ?? 0).padStart(13));
  console.log(m.padEnd(18) + row.join(""));
}
const errSummary = Object.entries(errors)
  .map(([m, by]) => `${m}: ${Object.entries(by).map(([e, c]) => `${e}x${c}`).join(", ")}`)
  .join(" | ");
if (errSummary) console.log(`\nErrors seen: ${errSummary}`);
