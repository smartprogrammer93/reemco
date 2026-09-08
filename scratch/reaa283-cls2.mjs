/**
 * REEA-283 CLS probe (v2): 360x800 headless, CLS while the results page
 * STREAMS. Reports per-entry detail. Usage: QA_BASE_URL=... node scratch/reaa283-cls2.mjs
 */
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const BASE = (process.env.QA_BASE_URL || "http://localhost:3123").replace(/\/$/, "");
process.env.LD_LIBRARY_PATH = `/tmp/lib/lib:/tmp:${process.env.LD_LIBRARY_PATH || ""}`;

const browser = await pw.launch({
  executablePath: await chromium.executablePath(),
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--single-process", "--no-zygote"],
  headless: true,
});
const ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
const page = await ctx.newPage();

await page.addInitScript(() => {
  window.__cls = 0;
  window.__clsEntries = [];
  const po = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (!e.hadRecentInput) {
        window.__cls += e.value;
        const names = (e.sources || []).slice(0, 4).map((s) => {
          const n = s.node;
          if (!n) return "text";
          const tag = (n.nodeName || "?").toLowerCase();
          const cls = n.className && typeof n.className === "string" ? "." + n.className.split(" ").slice(0, 2).join(".") : "";
          return tag + cls;
        });
        window.__clsEntries.push({ v: +e.value.toFixed(3), t: Math.round(e.startTime), names });
      }
    }
  });
  try { po.observe({ type: "layout-shift", buffered: true }); } catch {}
});

const url = `${BASE}/results?q=${encodeURIComponent("iPhone 17 Pro")}&c=SA`;
const t0 = Date.now();
await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => document.querySelectorAll("article.result-card").length > 0, { timeout: 40000 });
await page.waitForTimeout(3000);
const out = await page.evaluate(() => ({ cls: window.__cls, entries: window.__clsEntries }));
const detail = await page.evaluate(() => ({
  chips: document.querySelectorAll(".fresh-chip").length,
  chipText: document.querySelector(".fresh-chip")?.textContent ?? "",
  curLead: document.querySelector(".price-cur")?.textContent ?? "",
  altLead: document.querySelector(".price-alt")?.textContent ?? "",
}));
console.log(JSON.stringify({ url, ms: Date.now() - t0, ...out, ...detail }));
await browser.close();
