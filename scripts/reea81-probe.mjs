// REEA-81 timing probe — measures exactly what smoke-check.mjs step 4 measures
// (goto results page, waitUntil:"load", waitForSelector(".result-card")) but
// without the REEA-65 freshness-badge assertion, so pre-REEA-72 artifacts
// (which predate badges) can be baselined too.
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const BASE = (process.env.SMOKE_BASE_URL || "https://reemco-price-compare-preview.surge.sh").replace(/\/$/, "");

const LIB_DIR = "/tmp/al2023/lib";
if (!existsSync(LIB_DIR)) {
  try {
    const tarPath = "/tmp/al2023.tar";
    writeFileSync(
      tarPath,
      brotliDecompressSync(readFileSync(new URL("../node_modules/@sparticuz/chromium/bin/al2023.tar.br", import.meta.url))),
    );
    execSync(`mkdir -p /tmp/al2023 && tar -xf ${tarPath} -C /tmp/al2023`);
  } catch {}
}
if (existsSync(LIB_DIR)) {
  process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH
    ? `${LIB_DIR}:${process.env.LD_LIBRARY_PATH}`
    : LIB_DIR;
}

const browser = await pw.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
const page = await browser.newPage();
page.setDefaultTimeout(30000);
const t0 = Date.now();
await page.goto(`${BASE}/results?q=sony`, { waitUntil: "load" });
await page.waitForSelector(".result-card", { timeout: 25000 });
console.log(`TIMING results load (incl. hydration): ${Date.now() - t0}ms`);
await browser.close();
