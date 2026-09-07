import chromium from "@sparticuz/chromium";
import { chromium as pw } from "playwright-core";
const browser = await pw.launch({ executablePath: await chromium.executablePath(), args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"], headless: true });
const page = await browser.newPage();
page.on("response", (r) => { const s = r.status(); if (s >= 400) console.log("HTTP", s, r.url()); });
try {
  await page.goto("https://reemco.vercel.app/product/asus-rog-strix-scope-ii", { waitUntil: "domcontentloaded", timeout: 30000 });
  // Single long waitForFunction keeps the CDP session busy while hydration runs.
  const info = await page.waitForFunction(() => {
    const anchors = [...document.querySelectorAll("a")];
    const gt = anchors.filter((a) => /go to store/i.test(a.textContent || ""));
    if (!gt.length) return null;
    return JSON.stringify({ total: anchors.length, gt: gt.map((a) => a.href) });
  }, null, { timeout: 45000, polling: 1000 });
  console.log(info.jsonValue().then ? "(promise)" : "");
  const v = await info.jsonValue();
  const parsed = JSON.parse(String(v));
  console.log("total anchors:", parsed.total);
  for (const h of parsed.gt) console.log(" link:", h);
} catch (e) { console.log("ERR", String(e).split("\n")[0]); }
await browser.close().catch(() => {});
