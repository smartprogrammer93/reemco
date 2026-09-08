/**
 * REEA-283 CLS probe: 360x800 headless, measure cumulative layout shift
 * while the results page STREAMS (Suspense fallback -> staged flushes ->
 * converged grid), per-entry detail for diagnosis. This build needs the
 * context-scoped page flow (newContext + ctx.newPage), keeper included below.
 * Usage: HOME=/tmp QA_BASE_URL=http://localhost:3123 node scratch/reaa283-cls.mjs
 */
import { chromium as pw } from "playwright-core";

const BASE = (process.env.QA_BASE_URL || "http://localhost:3123").replace(/\/$/, "");
process.env.HOME = "/tmp";
process.env.FONTCONFIG_PATH = "/tmp/fonts";
process.env.LD_LIBRARY_PATH = `/tmp/lib/lib:/tmp:${process.env.LD_LIBRARY_PATH || ""}`;

const browser = await pw.launch({
  executablePath: "/tmp/chromium",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
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
          const cls =
            n.className && typeof n.className === "string"
              ? "." + n.className.split(" ").slice(0, 2).join(".")
              : "";
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
await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
const cls = await page.evaluate(() => window.__cls);
const entries = await page.evaluate(() => window.__clsEntries);
const chips = await page.evaluate(() => document.querySelectorAll(".fresh-chip").length);
const chipText = await page.evaluate(() => document.querySelector(".fresh-chip")?.textContent ?? "");
const curLead = await page.evaluate(() => document.querySelector(".price-cur")?.textContent ?? "");
const altLead = await page.evaluate(() => document.querySelector(".price-alt")?.textContent ?? "");
console.log(JSON.stringify({ url, ms: Date.now() - t0, cls, entries, chips, chipText, curLead, altLead }));
await browser.close();
