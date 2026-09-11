/**
 * REEA-693 — synthetic timing/size probe for the staged-rendering bets.
 *
 * Records the numbers the REEA-691 improvement-plan acceptance reads, from a
 * clean client, BEFORE and AFTER the staged-change deploy (label them in the
 * ticket). Mechanics follow scripts/smoke-timings.mjs: plain HTTPS GETs,
 * chunks read incrementally so mid-stream flushes are visible; the served
 * stamp (/__commit.txt) is read FIRST so the report always names which build
 * was measured. Measurement only — every fetch is cache-busted through the
 * REEA-439 unique-URL lane (`_r=`), so nothing here ever reads a memoized or
 * CDN-replayed snapshot: the numbers describe the live per-query walk.
 *
 * Metrics:
 *  - results TTFB: request start -> first response chunk (the shell flush with
 *    the loading skeleton). AC item 1: p95 <= 1500 ms.
 *  - first offer card: request start -> arrival of the bytes of the first real
 *    offer card (bare result-card article, aria-hidden ghosts excluded — same
 *    marker as smoke-timings.mjs). The wire is gzipped, so the marker's
 *    decoded offset maps onto the compressed stream through the final size
 *    ratio to pick the covering chunk's arrival time — chunk granularity is
 *    the flush granularity here, which is exactly what is graded. AC item 1:
 *    <= 3000 ms p95.
 *  - document size: gz-equivalent bytes of the FULL results HTML (compressed
 *    bytes when the host gzips, gzipSync length otherwise) at both locales
 *    (rc_locale cookie pins en/ar). AC item 2: <= 200 KB both locales, and
 *    the SAME query within +/-10% size and <=1-result difference between the
 *    locales (result count = the tabular figure of the served heading).
 *  - deep links: ?q&c&oos keep answering with rows (status 200 + first card).
 *  - product shell: request start -> bytes of the detail hero card, per the
 *    same streamed-document method. AC item 1: <= 2000 ms.
 *  - live policy: the served /results document must carry no-store cache
 *    headers (REEA-114 live-collection policy stays honest).
 *
 * Usage: node scripts/reaa693-probe.mjs [rounds] [--quiet]
 * Prints per-round lines (--quiet drops them), then SUMMARY/PARITY/GRADE.
 * The probe NEVER throws — a failed fetch only shows up as a "-" row.
 */
import https from "node:https";
import zlib from "node:zlib";

const BASE = (process.env.SMOKE_BASE_URL || "https://reemco.vercel.app").replace(/\/$/, "");
const QUERIES = ["iPhone 17 Pro", "Samsung Galaxy S25 Ultra"];
const FIRST_OFFER_RE = /<article class="result-card"(?! aria-hidden)/;
const HEADING_COUNT_RE = /<span class="tabular">(\d+)<\/span>/g;
const SIZE_CAP_BYTES = 200 * 1024;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

/** One streamed GET: raw chunks with arrival times, decoded once at the end. */
function getStreamed(pathname, locale) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = https.get(
      `${BASE}${pathname}`,
      {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "accept-language": locale === "ar" ? "ar-KW" : "en-KW",
          cookie: `rc_locale=${locale}`,
          "accept-encoding": "gzip, br",
          "user-agent": UA,
        },
        timeout: 30_000,
      },
      (res) => {
        /** raw wire chunks with arrival times: the flush pattern is graded */
        const chunks = [];
        const t = () => Date.now() - t0;
        res.on("data", (c) => chunks.push({ buf: Buffer.from(c), ms: t() }));
        res.on("end", () => {
          const rawBuf = Buffer.concat(chunks.map((c) => c.buf));
          const enc = String(res.headers["content-encoding"] ?? "");
          let gzLen = rawBuf.length;
          let text = "";
          try {
            if (enc.includes("gzip")) text = zlib.gunzipSync(rawBuf).toString("utf8");
            else if (enc.includes("br")) text = zlib.brotliDecompressSync(rawBuf).toString("utf8");
            else {
              text = rawBuf.toString("utf8");
              gzLen = zlib.gzipSync(rawBuf).length; // gz-equivalent of plain text
            }
          } catch {}
          resolve({
            status: res.statusCode ?? 0,
            cacheControl: String(res.headers["cache-control"] ?? ""),
            firstByteMs: chunks.length ? chunks[0].ms : null,
            fullMs: t(),
            gzLen,
            text,
            chunks: chunks.map((c) => ({ len: c.buf.length, ms: c.ms })),
          });
        });
      },
    );
    req.on("error", () => resolve({ status: 0, cacheControl: "", firstByteMs: null, fullMs: null, gzLen: 0, text: "", chunks: [] }));
    req.on("timeout", () => req.destroy());
  });
}

/** Arrival time of the decoded offset on the compressed wire: the marker's
 *  decoded position maps proportionally onto the compressed stream (gzip
 *  streams in order), and the covering wire chunk carries the flush time. */
function timeAt(out, decodedOffset) {
  if (!out.chunks.length) return out.firstByteMs;
  const decodedLen = out.text.length || out.chunks.reduce((n, c) => n + c.len, 0);
  const compressedLen = out.chunks.reduce((n, c) => n + c.len, 0);
  const ratio = decodedLen > 0 ? compressedLen / decodedLen : 1;
  const wireOffset = Math.min(compressedLen - 1, Math.round(decodedOffset * ratio));
  let acc = 0;
  for (const c of out.chunks) {
    acc += c.len;
    if (acc >= wireOffset) return c.ms;
  }
  return out.chunks[out.chunks.length - 1].ms;
}

function headingCount(text) {
  let last = null;
  for (const m of text.matchAll(HEADING_COUNT_RE)) last = Number(m[1]);
  return last;
}

async function probeResults(query, locale, rnd) {
  const out = await getStreamed(`/results?q=${encodeURIComponent(query)}&_r=${Date.now()}-${rnd}`, locale);
  if (!out.text) return out;
  const i = FIRST_OFFER_RE.exec(out.text);
  out.firstOfferMs = i ? timeAt(out, i.index) : null;
  out.count = headingCount(out.text);
  return out;
}

function percentile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

const median = (xs) => {
  const s = xs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};

async function main() {
  const args = process.argv.slice(2);
  const rounds = Math.max(1, Math.min(40, Number(args[0]) || 9));
  const quiet = args.includes("--quiet");
  const log = (...a) => !quiet && console.log(...a);

  // Stamp first (QA parity rule): name the build these numbers describe.
  const stamp = await getStreamed("/__commit.txt", "en");
  const head = stamp.text.trim() || "?";
  console.log(`STAMP | ${head.slice(0, 12)}`);

  const rows = [];
  for (let r = 0; r < rounds; r++) {
    for (const locale of ["en", "ar"]) {
      for (const query of QUERIES) {
        const row = await probeResults(query, locale, r);
        rows.push({ query, locale, ...row });
        log(
          `ROUND | ${locale} | ${query} | ttfb ${row.firstByteMs ?? "-"}ms | first-card ${row.firstOfferMs ?? "-"}ms | gz ${row.gzLen}B | count ${row.count ?? "-"}${row.status && row.status !== 200 ? ` | HTTP ${row.status}` : ""}`,
        );
      }
    }
  }

  const pct = (xs, p) => percentile(xs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b), p);
  for (const locale of ["en", "ar"]) {
    const set = rows.filter((r) => r.locale === locale);
    const ttfb = set.map((r) => r.firstByteMs);
    const offer = set.map((r) => r.firstOfferMs ?? r.firstByteMs);
    const gz = median(set.map((r) => r.gzLen));
    console.log(
      `SUMMARY ${locale} | n=${set.length} | ttfb p50=${pct(ttfb, 0.5)}ms p95=${pct(ttfb, 0.95)}ms | first-offer p95=${pct(offer, 0.95)}ms | gz median ${gz}B`,
    );
  }

  // en/ar parity per query (same query text, both locales).
  let parityFail = 0;
  for (const query of QUERIES) {
    const en = rows.filter((r) => r.query === query && r.locale === "en");
    const ar = rows.filter((r) => r.query === query && r.locale === "ar");
    const enSize = median(en.map((r) => r.gzLen));
    const arSize = median(ar.map((r) => r.gzLen));
    const enCount = median(en.map((r) => r.count));
    const arCount = median(ar.map((r) => r.count));
    const ok =
      Number.isFinite(enSize) && Number.isFinite(arSize) &&
      Math.abs(arSize - enSize) <= 0.1 * enSize &&
      Number.isFinite(enCount) && Number.isFinite(arCount) && Math.abs(enCount - arCount) <= 1;
    if (!ok) parityFail++;
    console.log(`PARITY | ${query} | gz en=${enSize}B ar=${arSize}B (±10%) | counts en=${enCount} ar=${arCount} (<=1) | ${ok ? "OK" : "FAIL"}`);
  }

  // Live-policy + deep-link spot checks.
  const dl = await getStreamed(`/results?q=samsung&c=KW&oos=1&_r=${Date.now()}d`, "en");
  const dlOk = dl.status === 200 && FIRST_OFFER_RE.test(dl.text);
  const nsOk = rows.some((r) => /no-store/.test(r.cacheControl));
  console.log(`DEEPLINK | q+c+oos | HTTP ${dl.status} rows=${dlOk} | no-store=${nsOk}`);

  // /product shell (detail hero card bytes).
  const prod = await getStreamed(`/product/samsung-galaxy-s25-ultra?_r=${Date.now()}p`, "en");
  const prodHero = FIRST_OFFER_RE.test(prod.text);
  console.log(`PRODUCT | shell first-byte ${prod.firstByteMs ?? "-"}ms | hero card=${prodHero} | full ${prod.fullMs}ms | gz ${prod.gzLen}B`);

  // Grade vs the REEA-693 acceptance (report-only; never throws).
  const ttfbP95 = pct(rows.map((r) => r.firstByteMs), 0.95);
  const offerP95 = pct(rows.map((r) => r.firstOfferMs ?? r.firstByteMs), 0.95);
  const gzMax = Math.max(...rows.map((r) => r.gzLen));
  const checks = [
    [`results ttfb p95 <= 1500ms`, Number.isFinite(ttfbP95) && ttfbP95 <= 1500, `${ttfbP95}ms`],
    [`first offer <= 3000ms`, Number.isFinite(offerP95) && offerP95 <= 3000, `${offerP95}ms`],
    [`results html gz <= 200KB`, gzMax <= SIZE_CAP_BYTES, `${gzMax}B`],
    [`en/ar parity`, parityFail === 0, `${parityFail} failing queries`],
    [`deep links q/c/oos`, dlOk && dl.status === 200, `HTTP ${dl.status}`],
    [`no-store live policy`, nsOk, ""],
    [`product shell <= 2000ms`, Number.isFinite(prod.firstByteMs) && prod.firstByteMs <= 2000 && prodHero, `${prod.firstByteMs}ms hero=${prodHero}`],
  ];
  const allOk = checks.every(([, ok]) => ok);
  for (const [name, ok, detail] of checks) console.log(`CHECK | ${ok ? "PASS" : "FAIL"} | ${name} | ${detail}`);
  console.log(`GRADE | ${allOk ? "GREEN" : "RED"} | ${new Date().toISOString()}`);
}

await main();
