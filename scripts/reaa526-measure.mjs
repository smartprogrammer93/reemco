/**
 * REEA-526 — batch-4 coverage re-measure on the served stamp.
 *
 * Fixed query set {iPhone 17 Pro, Nescafe coffee, dyson v15, دوف صابون}
 * x EN + AR x 5 rounds against the deployed /results path, cache-busted
 * every fetch (`rc_refresh=1` one-shot cookie + unique `_cb` param so
 * neither the app query cache nor the CDN layer replays a stale snapshot;
 * `rc_locale` pins the document locale).
 *
 * Mechanics follow scripts/reaa408-counts.mjs: stream the document, unwrap
 * the escaped flight payload, take the LAST `"notes":[…]` array as the
 * final coverage snapshot. Round passes for a merchant when hits>0 on any
 * query that round. Per-fetch extra evidence:
 *  - coverage-vs-rendered parity: the served coverage sentence ("Prices
 *    from …" / "No response from …", Arabic counterparts) must name exactly
 *    the merchants the final notes put on that side, AND each target
 *    side, AND every merchant with final-snapshot hits>0 is absent only as
 *    a soft late-feed signal (REEA-398 folds late offers in client-side,
 *    so SSR HTML may lag it), while zero-hit merchants must render zero
 *    rows; rows are counted by the retailer-name text node each offer row
 *    carries (streamed snapshots repeat the DOM so only presence matters);
 *  - KWD-native price labels present (`KD 3.180` figures);
 *  - AR documents carry dir="rtl".
 * Prints per-round lines (--quiet to drop), then the aggregate per-merchant
 * table + PASS/FAIL vs the >=4/5 bar.
 *
 * Usage: node scripts/reaa526-measure.mjs [rounds] [--quiet]
 */
const BASE = "https://reemco.vercel.app";
const QUERIES = ["iPhone 17 Pro", "Nescafe coffee", "dyson v15", "دوف صابون"];
const TARGETS = ["Sultan Center", "Quadra Stores", "PC Kuwait", "Lulu Hypermarket"];
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

function finalNotes(html) {
  const s = unwrap(html);
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

/** Last rendered coverage sentence in the document (final snapshot wins). */
function coverageSentence(html, locale) {
  const parts = [];
  const en = locale === "ar";
  for (const re of en
    ? [/لا يوجد رد من (.+?)\.(?![a-z.])/g, /أسعار من (.+?)\.(?![a-z.])/g]
    : [/No response from (.+?)\.(?![a-z.])/g, /Prices from (.+?)\.(?![a-z.])/g]) {
    let m;
    let last = null;
    while ((m = re.exec(html)) !== null) last = m[1];
    parts.push(last === null ? null : splitNames(last, en));
  }
  return { failed: parts[0], answered: parts[1] };
}

function splitNames(list, ar) {
  const sep = ar ? " و" : " and ";
  const tail = list.split(sep);
  const names = tail.slice(0, -1).flatMap((p) => p.split(", "));
  names.push(tail[tail.length - 1]);
  return names.map((n) => n.trim()).filter(Boolean);
}

function countName(html, name) {
  let c = 0;
  let i = -1;
  const needle = `>${name}<`;
  while ((i = html.indexOf(needle, i + 1)) >= 0) c++;
  return c;
}

async function one(q, locale, tag) {
  const headers = {
    accept: "text/html,application/xhtml+xml",
    "accept-language": locale,
    cookie: `rc_locale=${locale}; rc_refresh=1`,
    "user-agent": UA,
  };
  const t0 = Date.now();
  try {
    const r = await fetch(
      `${BASE}/results?q=${encodeURIComponent(q)}&_cb=${tag}`,
      { headers, signal: AbortSignal.timeout(35000) },
    );
    let h = "";
    const d = new TextDecoder();
    for await (const c of r.body) h += d.decode(c, { stream: true });
    h += d.decode();
    return {
      q,
      ms: Date.now() - t0,
      notes: finalNotes(h),
      sentence: coverageSentence(h, locale),
      nameCounts: Object.fromEntries(
        TARGETS.map((m) => [m, countName(h, m)]),
      ),
      rows: (h.match(/class="min-w-0 hover:underline"/g) ?? []).length,
      kwd: (h.match(/(?:KD|KWD) \d+(\.\d{1,3})?/g) ?? []).length,
      rtl: /dir="rtl"/.test(h),
    };
  } catch (e) {
    return {
      q,
      ms: Date.now() - t0,
      notes: [],
      sentence: null,
      nameCounts: {},
      rows: -1,
      kwd: -1,
      rtl: false,
      fetchError: String(e?.cause?.code ?? e?.message ?? e),
    };
  }
}

const rounds = Number(process.argv[2] || process.argv.find((a) => /^\d+$/.test(a)) || 5);
const quiet = process.argv.includes("--quiet");
const counts = {};
const perQ = {};
const errors = {};
const parity = { sentenceOk: 0, rowOk: 0, fails: [], totals: [], diffs: [] };
let kwdMissing = 0;
let rtlMissing = 0;
let tagN = 0;
let lateFeed = 0;

for (const locale of ["en", "ar"]) {
  counts[locale] ??= {};
  perQ[locale] ??= {};
  for (const m of TARGETS) counts[locale][m] = 0;
  for (let round = 1; round <= rounds; round++) {
    const rows = await Promise.all(
      QUERIES.map((q) => one(q, locale, `${Date.now()}-${round}-${locale}-${tagN++}`)),
    );
    const roundHits = new Set();
    for (const r of rows) {
      const hitOn = new Set();
      for (const n of r.notes) {
        counts[locale][n.merchant] ??= 0;
        perQ[locale][n.merchant] ??= {};
        perQ[locale][n.merchant][r.q] ??= 0;
        if ((n.hits ?? 0) > 0) {
          hitOn.add(n.merchant);
          perQ[locale][n.merchant][r.q]++;
        }
        if (n.error) {
          errors[n.merchant] ??= {};
          errors[n.merchant][n.error] = (errors[n.merchant][n.error] ?? 0) + 1;
        }
      }
      for (const m of hitOn) roundHits.add(m);

      // Coverage-line ↔ rendered-rows parity for this fetch.
      let sOk = false;
      let rOk = true;
      if (r.notes.length > 0 && r.sentence) {
        const expAnswered = new Set(r.notes.filter((n) => !n.error).map((n) => n.merchant));
        const expFailed = new Set(r.notes.filter((n) => n.error).map((n) => n.merchant));
        const gotAnswered = new Set(r.sentence.answered ?? []);
        const gotFailed = new Set(r.sentence.failed ?? []);
        const same = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
        sOk = same(expAnswered, gotAnswered) && same(expFailed, gotFailed);
        for (const m of TARGETS) {
          const hits = r.notes.find((n) => n.merchant === m)?.hits ?? 0;
          const rendered = (r.nameCounts[m] ?? 0) > 0;
          // Phantom coverage: rows rendered although the final notes say
          // the merchant answered with nothing. Strict.
          if (hits === 0 && rendered) rOk = false;
          // Missing SSR rows with hits>0 are the REEA-398 follow-up feed:
          // late offers converge in place client-side, so only count them
          // as a soft signal, not a failure.
          if (hits > 0 && !rendered) lateFeed++;
        }
      }
      if (sOk) parity.sentenceOk++;
      if (rOk) parity.rowOk++;
      if (!sOk || !rOk) parity.fails.push(`${locale} R${round} "${r.q}" sentence=${sOk} rows=${rOk}`);

      const sumHits = r.notes.reduce((s, n) => s + (n.hits ?? 0), 0);
      parity.totals.push(sumHits);
      parity.diffs.push(sumHits - r.rows);
      if (r.kwd === 0) kwdMissing++;
      if (locale === "ar" && !r.rtl) rtlMissing++;
      if (!quiet) {
        const brief = r.notes
          .map((n) => `${n.merchant}:${n.hits}${n.error ? `(${n.error})` : ""}`)
          .join(" ");
        console.log(
          `${locale} R${round} | ${r.q} | ${r.ms}ms rows=${r.rows} sumHits=${sumHits} kwd=${r.kwd} parity=${sOk && rOk ? "ok" : "FAIL"}${r.fetchError ? ` FETCH_ERR ${r.fetchError}` : ""} | ${brief}`,
        );
      }
    }
    for (const m of roundHits) counts[locale][m]++;
  }
}

console.log(`\nAggregate over ${rounds} rounds — rounds with hits>0 (need >=${Math.min(4, rounds)}):`);
console.log("merchant".padEnd(18) + ["en", "ar"].map((l) => l.padStart(7)).join(""));
const verdicts = {};
for (const m of TARGETS) {
  const en = counts.en[m];
  const ar = counts.ar[m];
  verdicts[m] = en >= 4 && ar >= 4;
  console.log(m.padEnd(18) + String(en).padStart(7) + String(ar).padStart(7) + (verdicts[m] ? " PASS" : " FAIL"));
}

console.log("\nPer-query detail (rounds hits>0 / " + rounds + "):");
for (const locale of ["en", "ar"]) {
  for (const m of TARGETS) {
    const byQ = QUERIES.map(
      (q) => `${q.slice(0, 10)}:${perQ[locale][m]?.[q] ?? 0}`,
    ).join(" ");
    console.log(`${locale} ${m.padEnd(17)} ${byQ}`);
  }
}

const n = parity.totals.length;
const diffHist = {};
for (const d of parity.diffs) diffHist[d] = (diffHist[d] ?? 0) + 1;
console.log(
  `\nParity: coverage sentence matches notes in ${parity.sentenceOk}/${n} fetches;` +
    ` hits>0 <-> rendered rows agree in ${parity.rowOk}/${n};` +
    ` offers(sumHits)/fetch median=${parity.totals.slice().sort((a, b) => a - b)[Math.floor(n / 2)] ?? "-"},` +
    ` rendered-row diff hist=${Object.entries(diffHist).sort((a, b) => a[0] - b[0]).map(([d, c]) => `${d}x${c}`).join(" ")}` +
    `; kwd-label-missing=${kwdMissing}, ar-no-rtl=${rtlMissing}, late-feed-not-yet-in-SSR=${lateFeed}`,
);
for (const line of parity.fails.slice(0, 8)) console.log(`PARITY_FAIL ${line}`);
const errSummary = Object.entries(errors)
  .map(([m, by]) => `${m}: ${Object.entries(by).map(([e, c]) => `${e} x${c}`).join(", ")}`)
  .join(" | ");
if (errSummary) console.log(`Errors seen: ${errSummary}`);

const allPass = TARGETS.every((m) => verdicts[m]);
console.log(`\nOVERALL: ${allPass ? "PASS" : "FAIL"}`);
