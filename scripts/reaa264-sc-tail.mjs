/**
 * REEA-264 — SC tail attribution on the production results path.
 *
 * Streams the deployed document chunk-by-chunk (cache-busted every fetch —
 * same rc_refresh + _cb discipline as scripts/reaa526-measure.mjs) and, from
 * each flushed flight snapshot, attributes per merchant:
 *   - settledAtMs: first time the merchant's note appears at all
 *     (the coverage line for that lane is honest then);
 *   - answeredMs: first time its note shows hits>0 (rows actually landed).
 * Full-set (content) time = last SETTLED note entering the document; byte
 * close (= finalize/headroom timer) is reported as context only — it is a
 * fixed ceiling, not the shopper-visible tail.
 *
 * SC avg arrival <= ~2 s is graded on the settled basis — same basis that
 * measured 3.51-3.63 s avg in REEA-257. Full-set p90 is graded against the
 * 4 s bar on the content basis. Measurement only — live fetches throughout.
 *
 * Usage: node sc-tail-264.mjs [rounds] [--quiet]
 */
const BASE = "https://reemco.vercel.app";
const QUERIES = ["iPhone 17 Pro", "Nescafe coffee", "dyson v15", "دوف صابون", "laptop"];
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

function unwrap(html) {
  let s = html;
  for (let i = 0; i < 4; i++) {
    const t = s.replace(/\\"/g, '"');
    if (t === s) break;
    s = t;
  }
  return s;
}

function lastNotes(s) {
  const re = /"notes":\[([^\]]*)\]/g;
  let m;
  let last = [];
  while ((m = re.exec(s)) !== null) {
    try {
      last = JSON.parse(`[${m[1]}]`);
    } catch {}
  }
  return last;
}

async function runOnce(query, cb) {
  const t0 = Date.now();
  const url = `${BASE}/results?q=${encodeURIComponent(query)}&_cb=${cb}`;
  const res = await fetch(url, {
    headers: { "user-agent": UA, cookie: "rc_refresh=1" },
    cache: "no-store",
  });
  if (!res.body) throw new Error("no stream");
  let buf = "";
  const settledAt = new Map();
  const answered = new Map();
  let scans = 0;
  for await (const chunk of res.body) {
    buf += Buffer.from(chunk).toString("utf8");
    const seen = (buf.match(/\\"?notes\\?":\[|"notes":\[/g) || []).length;
    if (seen === scans) continue;
    scans = seen;
    const notes = lastNotes(unwrap(buf));
    const now = Date.now() - t0;
    for (const n of notes) {
      if (!n || typeof n.merchant !== "string") continue;
      if (!settledAt.has(n.merchant)) settledAt.set(n.merchant, now);
      if (n.hits > 0 && !answered.has(n.merchant)) answered.set(n.merchant, now);
    }
  }
  const closeMs = Date.now() - t0;
  const settles = [...settledAt.values()];
  return {
    query,
    scSettle: settledAt.get("Sultan Center") ?? null,
    scAnswer: answered.get("Sultan Center") ?? null,
    contentMs: settles.length ? Math.max(...settles) : null,
    closeMs,
    settledCount: settledAt.size,
  };
}

function p90(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(0.9 * s.length) - 1)];
}
const avg = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);

async function main() {
  const args = process.argv.slice(2);
  const quiet = args.includes("--quiet");
  const rounds = Number(args.find((a) => /^\d+$/.test(a)) || 4);
  const rows = [];
  for (let r = 0; r < rounds; r++) {
    for (const q of QUERIES) {
      try {
        const row = await runOnce(q, `${Date.now()}-${r}-${q.slice(0, 4)}`);
        rows.push(row);
        if (!quiet)
          console.log(
            `round ${r + 1} | ${q.padEnd(14)} | SC settled ${String(row.scSettle ?? "-").padStart(5)} / ans ${String(row.scAnswer ?? "-").padStart(5)} | content ${String(row.contentMs).padStart(5)} close ${String(row.closeMs).padStart(5)} | notes ${row.settledCount}`,
          );
      } catch (e) {
        if (!quiet) console.log(`round ${r + 1} | ${q.padEnd(14)} | FAIL ${String(e.message).split("\n")[0]}`);
      }
    }
  }
  const sc = rows.map((r) => r.scSettle).filter((v) => typeof v === "number");
  const content = rows.map((r) => r.contentMs).filter((v) => typeof v === "number");
  const closes = rows.map((r) => r.closeMs).filter((v) => typeof v === "number");
  const scAvg = sc.length ? avg(sc) : null;
  const contentP90 = p90(content);
  console.log("---- aggregate ----");
  console.log(`runs=${rows.length} sc_settled=${sc.length}/${rows.length}`);
  console.log(`SC settled avg=${scAvg ?? "-"}ms max=${sc.length ? Math.max(...sc) : "-"}ms (bar: <=~2000ms)`);
  console.log(`full-set CONTENT p90=${contentP90 ?? "-"}ms avg=${avg(content)}ms max=${Math.max(...content)}ms (bar: <=4000ms)`);
  console.log(`byte-close (finalize ceiling) p90=${p90(closes)}ms avg=${avg(closes)}ms (context)`);
  const pass =
    scAvg !== null && scAvg <= 2000 && contentP90 !== null && contentP90 <= 4000;
  console.log(`VERDICT ${pass ? "GREEN" : "RED"} vs bars`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
