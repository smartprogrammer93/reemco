import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";
const BASE = "http://localhost:3123";
process.env.HOME = "/tmp";
process.env.FONTCONFIG_PATH = "/tmp/fonts";
process.env.LD_LIBRARY_PATH = `/tmp/lib:/tmp:${process.env.LD_LIBRARY_PATH || ""}`;
const browser = await pw.launch({ executablePath: await chromium.executablePath(), args: [...chromium.args, "--headless=new"], headless: true });
const ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
const page = await ctx.newPage();
await page.addInitScript(() => {
  window.__entries = [];
  const po = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.hadRecentInput) continue;
      const t = e.sources ? e.sources.map((s) => {
        const el = s.node ? (s.node.className && typeof s.node.className === "string" ? s.node.className : s.node.nodeName) : "?";
        return `${el}|${Math.round(s.previousRect.y)}->${Math.round(s.currentRect.y)}`;
      }).join(";") : "";
      window.__entries.push({ v: Math.round(e.value * 10000) / 10000, t: Math.round(e.startTime), src: t.slice(0, 160) });
    }
  });
  try { po.observe({ type: "layout-shift", buffered: true }); } catch {}
});
await page.goto(`${BASE}/results?q=${encodeURIComponent("iPhone 17 Pro")}&c=SA`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => document.querySelectorAll("article.result-card").length > 0, { timeout: 40000 });
await page.waitForTimeout(3500);
const out = await page.evaluate(() => ({ total: window.__entries.reduce((a, e) => a + e.v, 0), entries: window.__entries }));
console.log(JSON.stringify(out, null, 1));
await browser.close();
