/**
 * REEA-1247 — zero-offer page probe (committed, QA-replayable).
 *
 * Replays the zero-offer query set against the SERVED results page at 375/1280
 * in EN and AR and reports:
 *   - self-contradictory zero pages: "N carry this" (N>0) on a page with 0
 *     rendered offers, a "Prices from" sentence with no shelf price, an
 *     "Accessories for this product" band on a page with no product, or a
 *     recovery row that is not in market / does not name its matched term;
 *   - the measured recovery rate: zero-offer pages that render ≥1 in-market
 *     "closest match" (≤5, each labelled with the matched term);
 *   - the foreign-only state: "Not stocked in Kuwait" with foreign offers in
 *     their own separated band;
 *   - page-level horizontal overflow.
 *
 * Usage:
 *   BASE_URL=https://ns539626.ip-144-217-72.net OUT=/tmp/reea1247-probe.json \
 *     SHOTS=/tmp/reea1247-shots node scripts/reea1247-zero-page-probe.mjs
 *
 * QUERIES / LOCALES / WIDTHS are env-overridable; the default set is the live
 * zero-offer shape measured on the ticket (a nonsense query with hits that all
 * filtered out, a foreign-only accessory answer, an in-market accessory answer
 * that exercises recovery, and plain zero queries). Live data shifts, so the
 * measured recovery rate is reported as observed rather than asserted to a
 * fixed target.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const BASE = (process.env.BASE_URL || "https://ns539626.ip-144-217-72.net").replace(/\/$/, "");
const OUT = process.env.OUT || "/tmp/reea1247-probe.json";
const SHOTS = process.env.SHOTS || "/tmp/reea1247-shots";
const LOCALES = (process.env.LOCALES || "en,ar").split(",").filter(Boolean);
const WIDTHS = (process.env.WIDTHS || "375,1280").split(",").map(Number).filter(Boolean);
const QUERIES = (
  process.env.QUERIES ||
  "xyzzy no such thing,sony wh-1000xm6 ear pads,apple pencil pro tips,dyson airwrap case,kindle paperwhite cover,zzzzqqq"
)
  .split(",")
  .map((q) => q.trim())
  .filter(Boolean);
mkdirSync(SHOTS, { recursive: true });

const LIB_DIR = "/tmp/al2023/lib";
const VENDOR_DIR = new URL("./vendor/", import.meta.url);
if (!existsSync(LIB_DIR)) {
  try {
    writeFileSync(
      "/tmp/al2023.tar",
      brotliDecompressSync(
        readFileSync(new URL("../node_modules/@sparticuz/chromium/bin/al2023.tar.br", import.meta.url)),
      ),
    );
    execSync(`mkdir -p /tmp/al2023 && tar -xf /tmp/al2023.tar -C /tmp/al2023`);
  } catch {
    /* system chromium libs may already exist */
  }
}
if (existsSync(LIB_DIR)) {
  try {
    for (const f of ["libsqlite3.so.0", "libc.musl-x86_64.so.1", "libnssckbi.so"]) {
      const src = new URL(f, VENDOR_DIR);
      if (existsSync(src)) execSync(`cp -f ${decodeURIComponent(src.pathname)} ${LIB_DIR}/`);
    }
  } catch {
    /* vendored extras are optional */
  }
}
process.env.HOME = "/tmp";
process.env.FONTCONFIG_PATH = "/tmp/fonts";
process.env.LD_LIBRARY_PATH = [
  LIB_DIR,
  "/tmp/sqlite-extract/usr/lib/x86_64-linux-gnu",
  "/tmp",
  process.env.LD_LIBRARY_PATH || "",
]
  .filter(Boolean)
  .join(":");

const stamp = await fetch(`${BASE}/__commit.txt`).then((r) => r.text()).catch(() => null);
const health = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
console.log(`served stamp: ${stamp}`);
console.log(`health: ${JSON.stringify(health)}`);

const browser = await pw.launch({
  executablePath: await chromium.executablePath(),
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--headless=new"],
  headless: true,
});

const results = [];
for (const query of QUERIES) {
  for (const width of WIDTHS) {
    for (const locale of LOCALES) {
      const ctx = await browser.newContext({
        viewport: { width, height: width === 375 ? 812 : 900 },
        locale: locale === "ar" ? "ar-KW" : "en-KW",
        colorScheme: "light",
      });
      if (locale === "ar") await ctx.addCookies([{ name: "rc_locale", value: "ar", url: BASE }]);
      const page = await ctx.newPage();
      const url = `${BASE}/results?q=${encodeURIComponent(query)}&market=KW`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
      await page.waitForTimeout(6000);
      const data = await page.evaluate(() => {
        const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();
        const doc = document.documentElement;
        const meta = norm(document.querySelector(".rc-results-meta")?.textContent);
        const empty = !!document.querySelector('[data-empty-state="true"]');
        const zero = empty || /^0 results\b/.test(meta);
        const coverage = norm(document.querySelector(".coverage-line")?.textContent);
        const accessory = document.querySelector('[data-accessory-band="true"]');
        const recovery = document.querySelector('[data-recovery-band="true"]');
        const foreign = document.querySelector('[data-foreign-band="true"]');
        const notStocked = document.querySelector('[data-not-stocked="true"]');
        const recoveryItems = Array.from(recovery?.querySelectorAll("[data-recovery-item]") ?? []).map((el) => ({
          term: el.getAttribute("data-recovery-term") ?? "",
          market: el.getAttribute("data-recovery-market") ?? "",
          text: norm(el.textContent),
          hasPrice: /(?:KD|د\.ك)/.test(norm(el.textContent)),
        }));
        const foreignItems = Array.from(foreign?.querySelectorAll("[data-foreign-item]") ?? []).map((el) => ({
          term: el.getAttribute("data-recovery-term") ?? "",
          market: el.getAttribute("data-market") ?? "",
          text: norm(el.textContent),
        }));
        return {
          innerWidth: window.innerWidth,
          scrollWidth: doc.scrollWidth,
          overflow: doc.scrollWidth > window.innerWidth + 1,
          meta,
          zero,
          coverage,
          carryCount: (() => {
            const m = coverage.match(/(\d+)\s+carry this/);
            return m ? Number(m[1]) : 0;
          })(),
          saysCarry: /\b(\d+)\s+carry this/.test(coverage),
          saysPricesFrom: /Prices from|الأسعار من/.test(coverage),
          saysSimilar: /similar items|عناصر مشابهة/.test(coverage),
          accessoryPresent: !!accessory,
          recoveryPresent: !!recovery,
          recoveryLabel: norm(recovery?.querySelector(".related-band-title")?.textContent),
          recoveryItems,
          foreignPresent: !!foreign,
          foreignLabel: norm(foreign?.querySelector(".related-band-title")?.textContent),
          foreignItems,
          notStocked: !!notStocked,
          notStockedText: norm(notStocked?.textContent),
        };
      });
      await page.screenshot({
        path: `${SHOTS}/${query.replace(/[^a-z0-9]+/gi, "_")}-${width}-${locale}.png`,
        fullPage: false,
      });

      const contradictions = [];
      if (data.zero) {
        if (data.saysCarry && data.carryCount > 0) contradictions.push("claims N carry this on a 0-offer page");
        if (data.saysPricesFrom) contradictions.push("Prices from with no shelf price");
        if (data.accessoryPresent) contradictions.push("Accessories for this product on a page with no product");
        if (data.recoveryItems.length > 5) contradictions.push("more than 5 recovery items");
        for (const item of data.recoveryItems) {
          if (!item.term) contradictions.push("recovery item without a named matched term");
          if (item.market !== "KW") contradictions.push("recovery item not in market");
          if (!item.hasPrice) contradictions.push("recovery item without a rendered price");
        }
        if (data.notStocked && data.recoveryPresent) contradictions.push("'not stocked' beside an in-market recovery band");
      }
      const recovered = data.zero && data.recoveryItems.length > 0;
      results.push({
        query,
        width,
        locale,
        url,
        stamp,
        health,
        ...data,
        recovered,
        contradictions,
      });
      console.log(
        `${query} ${width}/${locale}: zero=${data.zero} carry=${data.saysCarry ? data.carryCount : "none"} ` +
          `pricesFrom=${data.saysPricesFrom} accessory=${data.accessoryPresent} ` +
          `recovery=${data.recoveryItems.length} foreign=${data.foreignItems.length} notStocked=${data.notStocked} ` +
          `overflow=${data.overflow} contradictions=${contradictions.length}`,
      );
      await ctx.close();
    }
  }
}
await browser.close();

const zeroRuns = results.filter((r) => r.zero);
const contradictory = results.filter((r) => r.contradictions.length > 0);
const recoveredRuns = zeroRuns.filter((r) => r.recovered);
const foreignOnlyRuns = zeroRuns.filter((r) => r.notStocked && r.foreignItems.length > 0 && !r.recoveryPresent);
const report = {
  stamp,
  health,
  generatedAt: new Date().toISOString(),
  queries: QUERIES,
  locales: LOCALES,
  widths: WIDTHS,
  zeroOfferRuns: zeroRuns.length,
  selfContradictoryRuns: contradictory.length,
  recoveryRate: zeroRuns.length > 0 ? recoveredRuns.length / zeroRuns.length : null,
  recoveredRuns: recoveredRuns.length,
  foreignOnlyRuns: foreignOnlyRuns.length,
  results,
};
writeFileSync(OUT, JSON.stringify(report, null, 2));

console.log(
  `\nZERO-OFFER SET: ${zeroRuns.length} zero pages measured; ` +
    `self-contradictory=${contradictory.length}; ` +
    `recovery rate=${report.recoveryRate === null ? "n/a" : (report.recoveryRate * 100).toFixed(1) + "%"} ` +
    `(${recoveredRuns.length}/${zeroRuns.length}); foreign-only separated=${foreignOnlyRuns.length}`,
);
console.log(`wrote ${OUT}`);

if (contradictory.length > 0) {
  console.error(
    "FAIL: self-contradictory zero pages:",
    contradictory.map((r) => `${r.query} ${r.width}/${r.locale}: ${r.contradictions.join("; ")}`),
  );
  process.exit(1);
}
const overflow = results.filter((r) => r.overflow);
if (overflow.length > 0) {
  console.error("FAIL: page-level horizontal overflow", overflow.map((r) => `${r.query} ${r.width}/${r.locale}`));
  process.exit(1);
}
console.log("OK: 0 self-contradictory zero-offer pages; recovery rate measured above.");
