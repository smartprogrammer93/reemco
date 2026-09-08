// REEA-224 rendered-layout check: items A1 (equal-height rows + one-line chip at 1280)
// and A3 (button pinned to one right-edge x, vertically centered vs wrapped price block at 480).
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";

// Same container bootstrap scripts/smoke-check.mjs uses: @sparticuz/chromium
// ships its NSS libs in al2023.tar.br but only wires them on Amazon Linux.
const LIB_DIR = "/tmp/al2023/lib";
const VENDOR_DIR = new URL("file:///work/reemco-price-compare/scripts/vendor/");
if (!existsSync(LIB_DIR)) {
  try {
    const tarPath = "/tmp/al2023.tar";
    writeFileSync(
      tarPath,
      brotliDecompressSync(readFileSync("/work/reemco-price-compare/node_modules/@sparticuz/chromium/bin/al2023.tar.br")),
    );
    execSync(`mkdir -p /tmp/al2023 && tar -xf ${tarPath} -C /tmp/al2023`);
  } catch {}
}
if (existsSync(LIB_DIR)) {
  try {
    for (const f of ["libsqlite3.so.0", "libc.musl-x86_64.so.1", "libnssckbi.so"]) {
      const src = new URL(f, VENDOR_DIR);
      if (existsSync(src)) execSync(`cp -f ${decodeURIComponent(src.pathname)} ${LIB_DIR}/`);
    }
  } catch {}
}
process.env.HOME = "/tmp";
process.env.FONTCONFIG_PATH = "/tmp/fonts";
process.env.LD_LIBRARY_PATH = [LIB_DIR, "/tmp/sqlite-extract/usr/lib/x86_64-linux-gnu", "/tmp", process.env.LD_LIBRARY_PATH || ""]
  .filter(Boolean)
  .join(":");

const BASE = "https://reemco.vercel.app";
const Q = encodeURIComponent("iPhone 17 Pro Max"); // multi-color same-retailer rows -> chips present

const browser = await pw.launch({
  executablePath: await chromium.executablePath(),
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--headless=new"],
  headless: true,
});
const keeper = await browser.newPage();
await keeper.goto("about:blank");
const page = await browser.newPage();
page.setDefaultTimeout(30000);

// --- A1 @1280: every retailer row equal height (~52-53px), chip one line ---
await page.setViewportSize({ width: 1280, height: 900 });
await page.goto(`${BASE}/results?q=${Q}`, { waitUntil: "load" });
await page.waitForSelector('section[aria-label="Prices and availability by retailer"] li', { timeout: 15000 });
const a1 = await page.evaluate(() => {
  const card = document.querySelector("article.result-card");
  const rows = [...card.querySelectorAll('section[aria-label="Prices and availability by retailer"] li')];
  const hs = rows.map((r) => Math.round(r.getBoundingClientRect().height));
  const chips = rows.flatMap((r) =>
    [...r.querySelectorAll(".label-token")].map((c) => {
      const cr = c.getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(c).lineHeight) || parseFloat(getComputedStyle(c).fontSize) * 1.5;
      return { h: Math.round(cr.height), lh: Math.round(lh * 10) / 10, lines: Math.round(cr.height / lh) };
    }),
  );
  return { rowCount: rows.length, hs, chipHeights: chips };
});
const rowsEqual = Math.max(...a1.hs) - Math.min(...a1.hs) <= 1;
const chipsOneLine = a1.chipHeights.every((c) => c.lines <= 1);
console.log("A1 @1280:", JSON.stringify(a1), "rowsEqual:", rowsEqual, "chipsOneLine:", chipsOneLine);

// --- A3 @480: buttons share right-edge x, centered vs cluster, min-height >= 44 ---
await page.setViewportSize({ width: 480, height: 900 });
await page.waitForTimeout(300); // let the reflow settle
const a3 = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('section[aria-label="Prices and availability by retailer"] .btn-primary')].slice(0, 12);
  const rows = btns.map((b) => {
    const br = b.getBoundingClientRect();
    const cluster = b.parentElement;
    const cr = cluster.getBoundingClientRect();
    return {
      right: Math.round(br.right * 10) / 10,
      btnH: Math.round(br.height * 10) / 10,
      btnMid: Math.round(((br.top + br.bottom) / 2 - cr.top) * 10) / 10,
      clusterMid: Math.round(cr.height / 2 * 10) / 10,
    };
  });
  return rows;
});
const xs = a3.map((r) => r.right);
const xSpread = Math.max(...xs) - Math.min(...xs);
const midOff = a3.map((r) => Math.abs(r.btnMid - r.clusterMid));
const minH = Math.min(...a3.map((r) => r.btnH));
console.log("A3 @480:", JSON.stringify(a3), "xSpread:", xSpread, "maxMidOffset:", Math.max(...midOff), "minBtnHeight:", minH);

await browser.close();
console.log(xSpread <= 1 && Math.max(...midOff) <= 3 && minH >= 44 && rowsEqual && chipsOneLine ? "LAYOUT OK" : "LAYOUT CHECK DETAILS ABOVE");
