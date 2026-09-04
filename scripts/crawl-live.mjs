import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const exePath = await chromium.executablePath();
const browser = await pw.launch({ executablePath: exePath, args: chromium.args, headless: true });
const page = await browser.newPage();
const BASE = "https://reemco-price-compare-preview.surge.sh";
const pages = ["/", "/search", "/results?q=sony", "/results?q=asus", "/results?q=zzzqqq"];
const all = new Map();
for (const p of pages) {
  const resp = await page.goto(BASE + p, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1500);
  const hrefs = await page.$$eval("a[href]", as => as.map(a => a.getAttribute("href")));
  const anchors = await page.$$eval("[id]", els => els.map(e => e.id));
  console.log(`PAGE ${p} status=${resp.status()}`);
  console.log(`  ids: ${JSON.stringify(anchors)}`);
  for (const h of hrefs) all.set(h, (all.get(h) || []).concat(p));
}
console.log("--- unique hrefs and target page checks:");
for (const [h, from] of all) {
  let status;
  if (h.startsWith("#")) {
    status = all.has(`#${h.slice(1)}`) ? "anchor-ok?" : "DEAD-ANCHOR";
    status = "in-page(checked below)";
  } else if (h.startsWith("/")) {
    const r = await page.goto(BASE + h.split("?")[0] + (h.includes("?") ? "?" + h.split("?")[1] : ""), { waitUntil: "domcontentloaded" });
    status = r.status();
  } else {
    try { const r = await page.request.get(h, { timeout: 20000 }); status = r.status(); } catch (e) { status = "ERR"; }
  }
  console.log(`${status} ${h}  (on ${[...new Set(from)].join(",")})`);
}
await browser.close();
