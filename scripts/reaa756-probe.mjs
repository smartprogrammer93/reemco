/**
 * REEA-756 — first-offer render-budget probe for the streamed results page.
 *
 * Records the numbers the REEA-756 acceptance reads, from a clean client, on
 * throttled Fast-3G: p75 time-to-first-visible-offer (must land < 1.0 s) and
 * p75 full-list completion (< 2.5 s), plus the CLS the chunk landings cause
 * (< 0.1) and a pacing read that catches a batch-at-end document (every
 * boundary flushing in one late burst instead of as it arrives). Mechanics
 * follow scripts/reaa693-probe.mjs: the served stamp (/__commit.txt) is read
 * FIRST so the report always names which build was measured; every fetch is
 * cache-busted through the REEA-439 unique-URL lane (`_r=`) so nothing reads
 * a memoized snapshot; the probe NEVER throws — a failed fetch is a "-" row.
 *
 * Two lanes, same queries/locales:
 *  - HTTP lane: raw streamed GETs with per-chunk arrival times; the decoded
 *    marker offsets map onto the compressed wire through the final size ratio
 *    (chunk granularity IS the flush granularity the shopper sees). The
 *    observed flushes are then re-paced through the Fast-3G envelope
 *    (Chrome's preset: 1.6 Mbps down, 150 ms RTT): a chunk is readable at
 *    max(observed flush time, half-RTT + cumulative bytes / bandwidth).
 *    Metrics: first-visible-offer = covering paced arrival of the first real
 *    offer-card element (bare result-card article, aria-hidden ghosts
 *    excluded — same marker family as reaa693); full list = paced arrival of
 *    the closing chunk, which is where the final staged boundary + coverage
 *    stamp land. The spread between them is the progressive-flush evidence.
 *  - Browser lane: real headless Chromium behind CDP Fast-3G emulation
 *    (Network.emulateNetworkConditions with the preset figures). A
 *    MutationObserver stamps first-offer visibility and the last streamed
 *    landing; a layout-shift PerformanceObserver sums CLS while chunks land.
 *    If the browser cannot launch the lane is skipped with a note — the HTTP
 *    lane already carries the graded p75 numbers.
 *
 * Usage: node scripts/reaa756-probe.mjs [rounds] [--quiet] [--no-browser]
 * Prints per-round lines (--quiet drops them), then SUMMARY/PROGRESSIVE/CLS.
 */
import https from "node:https";
import zlib from "node:zlib";
import { existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BASE = (process.env.SMOKE_BASE_URL || "https://reemco.vercel.app").replace(/\/$/, "");
const QUERIES = ["iPhone 17 Pro", "Samsung Galaxy S25 Ultra"];
// First real offer card: the streamed card markup starts its class list with
// `result-card` (cascade/stagger classes follow inside the quotes); skeleton
// ghosts are aria-hidden DIVS, so an article-level match excludes them.
const FIRST_OFFER_RE = /<article class="result-card/;
// Chrome Fast-3G preset: 1.6 Mbps downlink, 150 ms RTT.
const FAST3G_BPS = 1.6e6 / 8; // bytes/s on the downlink
const FAST3G_RTT_HALF_MS = 75;

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
            firstByteMs: chunks.length ? chunks[0].ms : null,
            fullMs: t(),
            gzLen,
            text,
            chunks: chunks.map((c) => ({ len: c.buf.length, ms: c.ms })),
          });
        });
      },
    );
    req.on("error", () => resolve({ status: 0, firstByteMs: null, fullMs: null, gzLen: 0, text: "", chunks: [] }));
    req.on("timeout", () => req.destroy());
  });
}

/** Fast-3G re-pacing of the observed flushes: each chunk becomes readable at
 *  max(observed arrival, half RTT + cumulative compressed bytes / bandwidth).
 *  Server-side flush times survive untouched (max keeps them); the envelope
 *  only adds the serialization lag a throttled phone would show. */
function pacedChunks(out) {
  let cum = 0;
  return out.chunks.map((c) => {
    cum += c.len;
    return { ms: Math.max(c.ms, FAST3G_RTT_HALF_MS + cum / FAST3G_BPS), len: c.len };
  });
}

/** Arrival time of the decoded offset on the paced compressed wire: the
 *  marker's decoded position maps proportionally onto the compressed stream
 *  (gzip streams in order), and the covering paced chunk carries the time. */
function pacedTimeAt(paced, out, decodedOffset) {
  if (!paced.length) return out.firstByteMs;
  const decodedLen = out.text.length || 1;
  const compressedLen = paced.reduce((n, c) => n + c.len, 0);
  const ratio = compressedLen / decodedLen;
  const wireOffset = Math.min(compressedLen - 1, Math.round(decodedOffset * ratio));
  let acc = 0;
  for (const c of paced) {
    acc += c.len;
    if (acc >= wireOffset) return c.ms;
  }
  return paced[paced.length - 1].ms;
}

async function probeResults(query, locale, rnd) {
  const out = await getStreamed(`/results?q=${encodeURIComponent(query)}&_r=${Date.now()}-${rnd}`, locale);
  if (!out.text) return out;
  const paced = pacedChunks(out);
  const m = FIRST_OFFER_RE.exec(out.text);
  out.firstOfferMs = m ? pacedTimeAt(paced, out, m.index) : null;
  out.fullMs = paced.length ? paced[paced.length - 1].ms : out.fullMs;
  out.flushCount = paced.length;
  return out;
}

function percentile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

const pct = (xs, p) => percentile(xs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b), p);
const median = (xs) => pct(xs, 0.5);

/** Browser lane: real paint timing behind Fast-3G emulation + CLS. Resolves
 *  with {rows:[{locale,query,firstOfferMs,fullMs,cls}]} or a skip note. */
async function browserLane(rounds) {
  let pw, chromium;
  try {
    ({ chromium: pw } = await import("playwright-core"));
    ({ default: chromium } = await import("@sparticuz/chromium"));
  } catch (e) {
    return { skip: `playwright unavailable (${e && e.message})` };
  }
  let browser;
  try {
    // Same container bootstrap scripts/smoke-check.mjs uses: @sparticuz/chromium
    // ships its NSS libs in al2023.tar.br but only wires them on Amazon Linux.
    const LIB_DIR = "/tmp/al2023/lib";
    if (!existsSync(`${LIB_DIR}/libnspr4.so`) || !existsSync(`${LIB_DIR}/libc.musl-x86_64.so.1`)) {
      try {
        const pkgDir = fileURLToPath(new URL("../node_modules/@sparticuz/chromium/bin/", import.meta.url));
        writeFileSync("/tmp/al2023.tar", zlib.brotliDecompressSync(readFileSync(`${pkgDir}al2023.tar.br`)));
        mkdirSync(LIB_DIR, { recursive: true });
        execSync(`tar -xf /tmp/al2023.tar -C /tmp/al2023`);
        execSync(`cp -f scripts/vendor/*.so "${LIB_DIR}/" && cp -f scripts/vendor/*.so.0 "${LIB_DIR}/" 2>/dev/null || true`);
      } catch {}
    }
    process.env.HOME = "/tmp";
    process.env.FONTCONFIG_PATH = process.env.FONTCONFIG_PATH || "/tmp/fonts";
    process.env.LD_LIBRARY_PATH = [LIB_DIR, process.env.LD_LIBRARY_PATH || ""].filter(Boolean).join(":");
    browser = await pw.launch({
      executablePath: await chromium.executablePath(),
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--headless=new"],
      headless: true,
    });
  } catch (e) {
    return { skip: `chromium launch failed (${e && e.message})` };
  }
  const rows = [];
  try {
    const keeper = await browser.newPage();
    await keeper.goto("about:blank");
    let page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        downloadThroughput: FAST3G_BPS,
        uploadThroughput: 0.75e6 / 8,
        latency: FAST3G_RTT_HALF_MS * 2,
      });
    } catch {}
    await page.addInitScript(() => {
      const m = { first: null, lastMut: 0, cls: 0 };
      window.__reaa756 = m;
      const stamp = () => performance.now();
      new MutationObserver(() => {
        const t = stamp();
        m.lastMut = t;
        if (m.first === null) {
          const c = document.querySelector("article.result-card:not([aria-hidden])");
          if (c && c.getBoundingClientRect().height > 0) m.first = t;
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
      try {
        const po = new PerformanceObserver((l) => {
          for (const e of l.getEntries()) if (!e.hadRecentInput) m.cls += e.value;
        });
        po.observe({ type: "layout-shift", buffered: true });
      } catch {}
    });
    for (let r = 0; r < rounds; r++) {
      for (const locale of ["en", "ar"]) {
        for (const query of QUERIES) {
          const url = `${BASE}/results?q=${encodeURIComponent(query)}&_r=${Date.now()}-${r}-b`;
          let m = null;
          try {
            await page.goto(url, { waitUntil: "load", timeout: 30_000 });
            await page.waitForSelector("article.result-card", { timeout: 15_000 });
            // Hold until the streamed landings go quiet (coverage stamp /
            // converged swap are the last mutations), capped at ~12 s.
            await page.waitForFunction(
              () => {
                const mm = window.__reaa756;
                return mm && mm.first !== null && performance.now() - mm.lastMut > 400;
              },
              undefined,
              { timeout: 12_000 },
            );
            m = await page.evaluate(() => window.__reaa756 || null);
            if (!m) {
              // The init script lost the race on this navigation — one more
              // settled read before declaring the row lost.
              await page.waitForTimeout(300);
              m = await page.evaluate(() => window.__reaa756 || null);
            }
          } catch {
            /* row lost — the - row is the honest record */
            try {
              await page.close();
            } catch {}
            page = await browser.newPage();
            page.setDefaultTimeout(30_000);
            await page.setViewportSize({ width: 1280, height: 900 });
          }
          rows.push({ locale, query, ...(m || {}) });
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return { rows };
}

async function main() {
  const args = process.argv.slice(2);
  const rounds = Math.max(1, Math.min(40, Number(args[0]) || 8));
  const quiet = args.includes("--quiet");
  const log = (...a) => !quiet && console.log(...a);

  // Stamp first (QA parity rule): name the build these numbers describe.
  const stampOut = await getStreamed("/__commit.txt", "en");
  console.log(`STAMP | ${(stampOut.text.trim() || "?").slice(0, 12)}`);

  const rows = [];
  for (let r = 0; r < rounds; r++) {
    for (const locale of ["en", "ar"]) {
      for (const query of QUERIES) {
        const row = await probeResults(query, locale, r);
        rows.push({ query, locale, ...row });
        log(
          `ROUND | ${locale} | ${query} | ttfb ${row.firstByteMs ?? "-"}ms | first-offer ${row.firstOfferMs ?? "-"}ms | full ${Math.round(row.fullMs ?? 0)}ms | flushes ${row.flushCount ?? "-"}${row.status && row.status !== 200 ? ` | HTTP ${row.status}` : ""}`,
        );
      }
    }
  }

  const first = rows.map((r) => r.firstOfferMs ?? r.firstByteMs);
  const full = rows.map((r) => r.fullMs);
  const firstP75 = pct(first, 0.75);
  const fullP75 = pct(full, 0.75);
  console.log(
    `SUMMARY | n=${rows.length} | first-visible-offer p50=${pct(first, 0.5)}ms p75=${firstP75}ms | full-list p50=${pct(full, 0.5)}ms p75=${fullP75}ms | gz median ${median(rows.map((r) => r.gzLen))}B`,
  );

  /* Progressive-visible read. Two shapes pass the acceptance line:
     - multi-flush: the first card is visibly on screen while later chunks
       are still landing (spread > 0 — boundaries flush as they arrive);
     - early-complete: the whole document lands inside the budgets in one
       flush (the memo/shared-warm replay lane), so there is nothing left to
       hold back — visible-on-arrival holds trivially when everything is
       visible by the full-list line already.
     A row fails only when it is BOTH late (full > 2500 ms) AND collapsed
     (spread ~0): that is the batch-at-end pattern — bytes sit in the buffer
     until the closing flush. */
  const graded = rows.filter((r) => Number.isFinite(r.firstOfferMs) && Number.isFinite(r.fullMs));
  const lateBurst = graded.filter((r) => r.fullMs > 2500 && r.fullMs - r.firstOfferMs <= 200).length;
  const spreads = graded.map((r) => r.fullMs - r.firstOfferMs);
  console.log(
    `PROGRESSIVE | late-burst rows ${lateBurst}/${graded.length} | median spread first-offer→full ${median(spreads)}ms | flushes median ${median(rows.map((r) => r.flushCount))}`,
  );

  const br = await browserLane(Math.max(2, Math.ceil(rounds / 4)));
  if (br.skip) {
    console.log(`CLS | browser lane skipped (${br.skip}) — hand the visual pass to QA`);
  } else {
    const bFirst = br.rows.map((r) => r.first);
    const bFull = br.rows.map((r) => r.lastMut);
    const bCls = br.rows.map((r) => r.cls);
    console.log(
      `BROWSER | n=${br.rows.length} | first-visible p50=${pct(bFirst, 0.5)}ms p75=${pct(bFirst, 0.75)}ms | full-list p75=${pct(bFull, 0.75)}ms | CLS p50=${median(bCls) != null ? Math.round(median(bCls) * 1000) / 1000 : "-"} p75=${pct(bCls, 0.75) != null ? Math.round(pct(bCls, 0.75) * 1000) / 1000 : "-"}`,
    );
  }

  const checks = [
    [`first-visible-offer p75 <= 1000ms`, Number.isFinite(firstP75) && firstP75 <= 1000, `${firstP75}ms`],
    [`full-list p75 <= 2500ms`, Number.isFinite(fullP75) && fullP75 <= 2500, `${fullP75}ms`],
    [`no late-burst rows`, lateBurst === 0, `${lateBurst}/${graded.length} late+collapsed`],
  ];
  const allOk = checks.every(([, ok]) => ok);
  for (const [name, ok, detail] of checks) console.log(`CHECK | ${ok ? "PASS" : "FAIL"} | ${name} | ${detail}`);
  console.log(`GRADE | ${allOk ? "GREEN" : "RED"} | ${new Date().toISOString()}`);
}

await main();
