/**
 * REEA-822 — exact-SKU lead browser check (check-1 verification).
 * Loads /results?q=EF-PS931CBEGWW on BASE, waits for the card grid, and
 * prints: first card title, card count, OOS row state. EN + AR.
 * Usage: SMOKE_BASE_URL=http://localhost:3123 node scripts/reea822-sku-lead-check.mjs
 * SMOKE_PATH overrides the pathname (default /results, QA's repro also uses /).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const BASE = (process.env.SMOKE_BASE_URL || "https://reemco.vercel.app").replace(/\/$/, "");

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
      execSync(
        `cp -f scripts/vendor/libsqlite3.so.0 scripts/vendor/libc.musl-x86_64.so.1 scripts/vendor/libnssckbi.so "${LIB_DIR}/" 2>/dev/null || true`,
      );
    } catch {}
  }
  process.env.HOME = "/tmp";
  process.env.FONTCONFIG_PATH = "/tmp/fonts";
  process.env.LD_LIBRARY_PATH = [LIB_DIR, "/tmp", process.env.LD_LIBRARY_PATH || ""].filter(Boolean).join(":");
  return pw.launch({
    executablePath: await chromium.executablePath(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--headless=new"],
    headless: true,
  });
}

const browser = await launchBrowser();
try {
  const keeper = await browser.newPage();
  await keeper.goto("about:blank");
  const page = await browser.newPage();
  page.setDefaultTimeout(40_000);
  await page.setViewportSize({ width: 375, height: 812 });
  for (const locale of ["en", "ar"]) {
    await page.goto(`${BASE}${process.env.SMOKE_PATH || "/results"}?q=EF-PS931CBEGWW&_r=${Date.now()}-${locale}`, {
      waitUntil: "load",
      timeout: 40_000,
      headers: { cookie: `rc_locale=${locale}` },
    });
    // Locale rides the cookie jar; set it explicitly per pass.
    await page.context().addCookies([{ name: "rc_locale", value: locale, url: BASE }]);
    await page.goto(`${BASE}${process.env.SMOKE_PATH || "/results"}?q=EF-PS931CBEGWW&_r=${Date.now()}-${locale}`, {
      waitUntil: "load",
      timeout: 40_000,
    });
    try {
      await page.waitForFunction(
        () => document.querySelectorAll("article.result-card").length > 0 ||
              /0 results|0 نتائج/.test(document.body.textContent ?? ""),
        undefined,
        { timeout: 25_000 },
      );
    } catch {}
    const out = await page.evaluate(() => {
      const cards = [...document.querySelectorAll("article.result-card")];
      const first = cards[0];
      return {
        count: cards.length,
        firstTitle: first?.querySelector("h2")?.textContent?.trim() ?? null,
        firstOos: first?.classList.contains("is-oos") ?? null,
        zeroState: /0 results|0 نتائج/.test(document.body.textContent ?? ""),
        oosRows: [...document.querySelectorAll("article.result-card [class*='stock']")].length,
        text: (document.body.textContent ?? "").slice(0, 200),
      };
    });
    console.log(`SKU | ${locale} | cards=${out.count} | zero=${out.zeroState} | firstOos=${out.firstOos}`);
    console.log(`    first: ${out.firstTitle}`);
  }
} finally {
  await browser.close().catch(() => {});
}
