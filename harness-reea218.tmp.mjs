// REEA-218 baseline harness — smoke step-4 / reea81-probe semantics:
// goto results page (waitUntil: load) + waitForSelector('.result-card').
// N sequential samples, fresh context per sample.
import { chromium as pw } from "playwright-core";
import mod from "@sparticuz/chromium";
const chromium = mod.default || mod;
process.env.LD_LIBRARY_PATH = `/tmp/al2023/lib:${process.env.LD_LIBRARY_PATH || ""}`;
const BASE = "https://reemco.vercel.app";
const Q = process.argv[2] || "sony";
const N = Number(process.argv[3] || 12);
const browser = await pw.launch({ executablePath: await chromium.executablePath(), headless: true, args: chromium.args });
const out = [];
for (let i = 0; i < N; i++) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  const t0 = Date.now();
  try {
    await page.goto(`${BASE}/results?q=${encodeURIComponent(Q)}`, { waitUntil: "load" });
    await page.waitForSelector(".result-card", { timeout: 25000 });
    out.push(Date.now() - t0);
  } catch (e) {
    out.push(null);
    console.error(`sample ${i + 1} FAILED: ${String(e).slice(0, 120)}`);
  }
  await ctx.close();
}
await browser.close();
console.log(JSON.stringify({ query: Q, n: out.length, samples_ms: out.filter((x) => x !== null), failures: out.filter((x) => x === null).length }));
