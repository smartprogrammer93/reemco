/**
 * REEA-1237 — end-to-end proof on the live box: a real browser page view on
 * /results fires exactly one `page_view` beacon and the served weekly payload
 * increments shopper_serves by that count.
 *
 * Deliberately launches with a NON-headless User-Agent: the beacon transport
 * gates `page_view` on the shared bot predicate (lib/bot-ua.ts), and the
 * default Playwright UA contains "HeadlessChrome" — which is excluded by
 * design, so a default headless probe would prove nothing.
 */
import { chromium } from "playwright-core";

const BASE = "https://ns539626.ip-144-217-72.net";
const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function metrics() {
  const res = await fetch(`${BASE}/api/metrics/weekly?weeks=1`);
  const body = await res.json();
  const week = Object.keys(body.weeks).sort().pop();
  return { week, w: body.weeks[week] };
}

const before = await metrics();
console.log("BEFORE", before.week, {
  shopper_serves: before.w.shopper_serves,
  ctr_denominator_shopper: before.w.ctr_denominator_shopper,
  offer_link_ctr_shopper: before.w.offer_link_ctr_shopper,
  offer_link_clicks: before.w.offer_link_clicks,
});

const browser = await chromium.launch({
  executablePath: "/opt/ms-playwright/chromium-1194/chrome-linux/chrome",
  headless: true,
});
const ctx = await browser.newContext({ userAgent: CHROME_UA });
const page = await ctx.newPage();
const beacons = [];
page.on("request", (req) => {
  if (req.url().includes("/api/events") && req.method() === "POST") {
    beacons.push(req.postData());
  }
});
await page.goto(`${BASE}/results?q=sony`, { waitUntil: "domcontentloaded", timeout: 60_000 });
// Hydration + the mount effect need a moment; give the shelf time to paint.
await page.waitForTimeout(12_000);
await page.screenshot({ path: "/tmp/reea1237-results.png", fullPage: false });
await browser.close();

console.log("BEACONS", JSON.stringify(beacons));
const after = await metrics();
console.log("AFTER", after.week, {
  shopper_serves: after.w.shopper_serves,
  ctr_denominator_shopper: after.w.ctr_denominator_shopper,
  offer_link_ctr_shopper: after.w.offer_link_ctr_shopper,
  offer_link_clicks: after.w.offer_link_clicks,
});

const pageViewBeacons = beacons.filter((b) => b && b.includes('"page_view"')).length;
const delta = (after.w.shopper_serves ?? 0) - (before.w.shopper_serves ?? 0);
console.log(
  JSON.stringify({
    pageViewBeacons,
    shopper_servesDelta: delta,
    pass: pageViewBeacons >= 1 && delta === pageViewBeacons,
  }),
);
