/**
 * REEA-822 — mobile CLS attribution probe for the streamed results page.
 *
 * QA (REEA-789 check 6) measured mobile CLS = 0.1983 at 375x812 — a single
 * shift event at ~1.8 s attributed to the footer moving while content above
 * it changes height. This probe reproduces the measurement and names the
 * SHIFT SOURCES: every layout-shift entry records its time, value, and the
 * moving nodes (tag + class chain + previous/current rect tops) so the
 * late-swapping block is identified, not guessed.
 *
 * Mechanics follow scripts/reaa756-probe.mjs (CDP Fast-3G, @sparticuz
 * chromium bootstrap), but at 375x812 with a mobile UA and per-entry source
 * attribution. Prints the stamp first (QA parity rule).
 *
 * Usage: node scripts/reea822-cls-probe.mjs [rounds] [query ...]
 */
import https from "node:https";
import zlib from "node:zlib";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const BASE = (process.env.SMOKE_BASE_URL || "https://reemco.vercel.app").replace(/\/$/, "");
const QUERIES = process.argv.slice(2).filter((a) => !/^\d+$/.test(a));
const ROUNDS = Math.max(1, Math.min(10, Number(process.argv[2]) || 3));
if (QUERIES.length === 0) QUERIES.push("iPhone 17 Pro", "samsung galaxy s25");
const FAST3G_BPS = 1.6e6 / 8;
const FAST3G_RTT_HALF_MS = 75;
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

function getStreamed(pathname, locale) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = https.get(
      `${BASE}${pathname}`,
      {
        headers: {
          accept: "text/html",
          "accept-language": locale === "ar" ? "ar-KW" : "en-KW",
          cookie: `rc_locale=${locale}`,
          "accept-encoding": "gzip, br",
          "user-agent": UA,
        },
        timeout: 30_000,
      },
      (res) => {
        const chunks = [];
        const t = () => Date.now() - t0;
        res.on("data", (c) => chunks.push({ buf: Buffer.from(c), ms: t() }));
        res.on("end", () => {
          const raw = Buffer.concat(chunks.map((c) => c.buf));
          const enc = String(res.headers["content-encoding"] ?? "");
          let text = "";
          try {
            if (enc.includes("gzip")) text = zlib.gunzipSync(raw).toString("utf8");
            else if (enc.includes("br")) text = zlib.brotliDecompressSync(raw).toString("utf8");
            else text = raw.toString("utf8");
          } catch {}
          resolve({ status: res.statusCode ?? 0, text, gzLen: raw.length });
        });
      },
    );
    req.on("error", () => resolve({ status: 0, text: "", gzLen: 0 }));
    req.on("timeout", () => req.destroy());
  });
}

async function launchBrowser() {
  const { chromium: pw } = await import("playwright-core");
  const { default: chromium } = await import("@sparticuz/chromium");
  const LIB_DIR = "/tmp/al2023/lib";
  if (!existsSync(`${LIB_DIR}/libnspr4.so`) || !existsSync(`${LIB_DIR}/libsqlite3.so.0`)) {
    try {
      const pkgDir = fileURLToPath(new URL("../node_modules/@sparticuz/chromium/bin/", import.meta.url));
      writeFileSync("/tmp/al2023.tar", zlib.brotliDecompressSync(readFileSync(`${pkgDir}al2023.tar.br`)));
      mkdirSync(LIB_DIR, { recursive: true });
      execSync(`tar -xf /tmp/al2023.tar -C /tmp/al2023`);
      // NSS dlopens libsqlite3.so.0 and the libnssckbi.so root-cert module;
      // the musl loader the Alpine-built extras need ships beside them.
      execSync(
        `cp -f scripts/vendor/libsqlite3.so.0 scripts/vendor/libc.musl-x86_64.so.1 scripts/vendor/libnssckbi.so "${LIB_DIR}/" 2>/dev/null || true`,
      );
    } catch {}
  }
  process.env.HOME = "/tmp";
  process.env.FONTCONFIG_PATH = "/tmp/fonts";
  process.env.LD_LIBRARY_PATH = [LIB_DIR, "/tmp/sqlite-extract/usr/lib/x86_64-linux-gnu", "/tmp", process.env.LD_LIBRARY_PATH || ""]
    .filter(Boolean)
    .join(":");
  return pw.launch({
    executablePath: await chromium.executablePath(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--headless=new"],
    headless: true,
  });
}

const INIT = () => {
  const m = { cls: 0, shifts: [], lastMut: 0, first: null };
  window.__reea822 = m;
  new MutationObserver(() => {
    const t = performance.now();
    m.lastMut = t;
    if (m.first === null) {
      const c = document.querySelector("article.result-card:not([aria-hidden])");
      if (c && c.getBoundingClientRect().height > 0) m.first = t;
    }
  }).observe(document, { childList: true, subtree: true });
  try {
    const po = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (e.hadRecentInput) continue;
        m.cls += e.value;
        m.shifts.push({
          t: Math.round(e.startTime),
          value: Number(e.value.toFixed(4)),
          sources: (e.sources ?? []).map((s) => {
            const n = s.node;
            const desc = n
              ? `${n.tagName?.toLowerCase() ?? "?"}.${String(n.className ?? "").split(/\s+/).filter(Boolean).slice(0, 4).join(".")}`
              : "?";
            const prev = s.previousRect ? Math.round(s.previousRect.y) : null;
            const cur = s.currentRect ? Math.round(s.currentRect.y) : null;
            const dy = prev != null && cur != null ? cur - prev : null;
            return `${desc} y:${prev}->${cur} (${dy})`;
          }),
        });
      }
    });
    po.observe({ type: "layout-shift", buffered: true });
  } catch {}
};

async function main() {
  const stamp = await getStreamed("/__commit.txt", "en");
  console.log(`STAMP | ${(stamp.text.trim() || "?").slice(0, 12)}`);
  const browser = await launchBrowser();
  try {
    // Keeper page keeps the browser alive between navigations (smoke-check
    // pattern — started without a startup window it dies on page.close).
    const keeper = await browser.newPage();
    await keeper.goto("about:blank");
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    await page.setViewportSize({ width: 375, height: 812 });
    try {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        downloadThroughput: FAST3G_BPS,
        uploadThroughput: 0.75e6 / 8,
        latency: FAST3G_RTT_HALF_MS * 2,
      });
    } catch {}
    await page.addInitScript(INIT);
    for (let r = 0; r < ROUNDS; r++) {
      for (const locale of ["en", "ar"]) {
        for (const query of QUERIES) {
          const url = `${BASE}/results?q=${encodeURIComponent(query)}&_r=${Date.now()}-${r}-${locale}`;
          try {
            await page.goto(url, { waitUntil: "load", timeout: 30_000 });
            await page.waitForFunction(
              () => {
                const mm = window.__reea822;
                // Settled = a real card painted AND mutations have gone quiet
                // (the converged swap / coverage stamp are the last ones).
                return mm && mm.first !== null && performance.now() - mm.lastMut > 800;
              },
              undefined,
              { timeout: 20_000 },
            );
            const m = await page.evaluate(() => window.__reea822);
            console.log(
              `RUN | r${r} | ${locale} | ${query} | CLS ${m.cls.toFixed(4)} | shifts ${m.shifts.length} | first-offer ${m.first == null ? "-" : Math.round(m.first)}ms`,
            );
            for (const s of m.shifts) {
              console.log(`    shift @${s.t}ms value=${s.value}`);
              for (const src of s.sources.slice(0, 8)) console.log(`      ${src}`);
            }
          } catch (e) {
            console.log(`RUN | r${r} | ${locale} | ${query} | ERROR ${e.message?.slice(0, 80)}`);
          }
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
}
main();
