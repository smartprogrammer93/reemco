// REEA-81: render-timing harness — replicates scripts/smoke-check.mjs step-4
// measurement exactly: goto(results, waitUntil:"load") + waitForSelector(".result-card").
// Usage: SMOKE_BASE_URL=https://... node timing-harness.mjs [N]
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const BASE = (process.env.SMOKE_BASE_URL || "https://reemco.vercel.app").replace(/\/$/, "");
const FIXTURE_QUERY = process.env.SMOKE_FIXTURE_QUERY || "sony";
const N = Number(process.argv[2] || 20);

const LIB_DIR = "/tmp/al2023/lib";
if (!existsSync(LIB_DIR)) {
  try {
    const tarPath = "/tmp/al2023.tar";
    writeFileSync(tarPath, brotliDecompressSync(readFileSync(new URL("../repo/node_modules/@sparticuz/chromium/bin/al2023.tar.br", import.meta.url))));
    execSync(`mkdir -p /tmp/al2023 && tar -xf ${tarPath} -C /tmp/al2023`);
  } catch {}
}
if (existsSync(LIB_DIR)) {
  process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH ? `${LIB_DIR}:${process.env.LD_LIBRARY_PATH}` : LIB_DIR;
}

const browser = await pw.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
const times = [];
for (let i = 0; i < N; i++) {
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  const t0 = Date.now();
  await page.goto(`${BASE}/results?q=${encodeURIComponent(FIXTURE_QUERY)}`, { waitUntil: "load" });
  await page.waitForSelector(".result-card", { timeout: 25000 });
  times.push(Date.now() - t0);
  await page.close();
}
await browser.close();
times.sort((a, b) => a - b);
const p = (q) => times[Math.min(times.length - 1, Math.ceil(q * times.length) - 1)];
console.log(JSON.stringify({ base: BASE, n: N, samples: times, min: times[0], p50: p(0.5), p95: p(0.95), max: times[times.length - 1] }));
