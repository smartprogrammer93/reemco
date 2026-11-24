/**
 * REEA-1128 — live verification for the broken results thumbnails.
 *
 * QA's repro: `/results?q=headphones` on desktop intermittently rendered
 * broken-image frames and logged `Failed to load resource: 403` for
 * `cdn.shopify.com` product photos. The fix routes those photos through the
 * same-origin `/api/image` proxy, which always answers 200 (image or neutral
 * glyph), so the browser never sees a failing third-party image.
 *
 * What this script proves, against the live box:
 *  1. the served stamp (`/__commit.txt`) and health probe (`/api/health`);
 *  2. `/api/image?u=<shopify url>` answers 200 with an image content-type;
 *  3. four cold loads of `/results?q=headphones` produce ZERO broken images
 *     (every <img> decoded, naturalWidth > 0) and ZERO image 4xx/5xx;
 *  4. no `Failed to load resource` console error on the page.
 *
 * Usage: node scripts/verify-reea1128.mjs [baseUrl]
 */
import { chromium } from "playwright-core";

const BASE = (process.argv[2] || process.env.BASE_URL || "https://ns539626.ip-144-217-72.net").replace(/\/$/, "");
const EXEC = process.env.CHROME_PATH || "/opt/ms-playwright/chromium-1194/chrome-linux/chrome";
const SHOPIFY_SAMPLE =
  "https://cdn.shopify.com/s/files/1/0677/2470/6005/files/JBL_Tune_780NC_Wireless_Over-Ear_Adaptive_Noise_Cancelling_Headphones_76H_Playtime.jpg?v=1776607449";

const failures = [];
const note = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

async function stamp() {
  for (const [label, path] of [
    ["commit", "/__commit.txt"],
    ["health", "/api/health"],
  ]) {
    try {
      const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(20_000) });
      const body = (await res.text()).trim().slice(0, 400);
      console.log(`stamp ${label}: HTTP ${res.status} ${body}`);
      note(res.ok, `stamp ${label} reachable`);
    } catch (err) {
      note(false, `stamp ${label} reachable`, String(err));
    }
  }
}

async function proxyProbe() {
  const url = `${BASE}/api/image?u=${encodeURIComponent(SHOPIFY_SAMPLE)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const type = res.headers.get("content-type") ?? "";
    const bytes = (await res.arrayBuffer()).byteLength;
    console.log(`proxy: HTTP ${res.status} ${type} ${bytes} bytes`);
    note(res.status === 200, "proxy answers 200");
    note(type.startsWith("image/"), "proxy body is an image");
    note(bytes > 0, "proxy body is non-empty");
  } catch (err) {
    note(false, "proxy reachable", String(err));
  }
}

async function pageLoads(browser, round) {
  // A fresh context per round = a cold browser cache, the state QA saw the 403 in.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const consoleErrors = [];
  const badImages = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (/Failed to load resource|403|ERR_/i.test(text)) consoleErrors.push(text);
  });
  page.on("response", (res) => {
    const type = res.headers()["content-type"] ?? "";
    if (!type.startsWith("image/")) return;
    if (res.status() >= 400) badImages.push(`${res.status()} ${res.url().slice(0, 120)}`);
  });

  await page.goto(`${BASE}/results?q=headphones`, { waitUntil: "load", timeout: 180_000 });
  // Live offers stream in after the shell; give the cards their paint budget.
  await page.waitForTimeout(9000);
  const imgs = await page.evaluate(() =>
    Array.from(document.images).map((img) => ({
      src: img.currentSrc || img.src,
      complete: img.complete,
      naturalWidth: img.naturalWidth,
    })),
  );
  const broken = imgs.filter((i) => !i.complete || i.naturalWidth === 0);
  console.log(
    `round ${round}: ${imgs.length} images, ${broken.length} broken, ${badImages.length} bad responses, ${consoleErrors.length} console errors`,
  );
  for (const b of broken) console.log(`   broken: ${b.src.slice(0, 140)}`);
  for (const b of badImages) console.log(`   bad: ${b}`);
  for (const c of consoleErrors) console.log(`   console: ${c.slice(0, 200)}`);
  note(imgs.length > 0, `round ${round} rendered product images`, `${imgs.length} imgs`);
  note(broken.length === 0, `round ${round} every image decoded`);
  note(badImages.length === 0, `round ${round} no image 4xx/5xx`);
  note(consoleErrors.length === 0, `round ${round} no image console errors`);
  await ctx.close();
}

await stamp();
await proxyProbe();

const browser = await chromium.launch({ executablePath: EXEC, args: ["--no-sandbox"] });
try {
  for (let round = 1; round <= 4; round++) await pageLoads(browser, round);
} finally {
  await browser.close();
}

console.log(`\n${failures.length === 0 ? "OK — REEA-1128 verification passed" : `FAILED (${failures.length}): ${failures.join("; ")}`}`);
process.exit(failures.length === 0 ? 0 : 1);
