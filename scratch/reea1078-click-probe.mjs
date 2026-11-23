import { chromium } from "playwright-core";

const BASE = "https://ns539626.ip-144-217-72.net";
const before = await (await fetch(`${BASE}/api/metrics/weekly?weeks=2`)).json();
const w = before.weeks["2026-W48"];
console.log("before clicks:", w?.offer_link_clicks);

const browser = await chromium.launch({
  executablePath: "/opt/ms-playwright/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
page.on("requestfailed", (r) => console.log("REQFAIL", r.url(), r.failure()?.errorText));
page.on("response", (r) => { if (r.url().includes("/api/events")) console.log("EVENTS", r.status(), r.request().method()); });
await page.goto(`${BASE}/results?q=iphone`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector('a.cta-lead', { timeout: 60000 });
const href = await page.getAttribute('a.cta-lead', 'href');
console.log("CTA href:", href);
// Click the first offer CTA (opens a new tab; keep the page alive for the beacon).
const [popup] = await Promise.all([
  page.waitForEvent("popup", { timeout: 15000 }).catch(() => null),
  page.click('a.cta-lead', { noWaitAfter: true }),
]);
await page.waitForTimeout(1500);
if (popup) await popup.close();
await browser.close();
await new Promise((r) => setTimeout(r, 2500));
const after = await (await fetch(`${BASE}/api/metrics/weekly?weeks=2`)).json();
console.log("after clicks:", after.weeks["2026-W48"]?.offer_link_clicks);
