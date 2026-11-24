/**
 * REEA-1128 — live verification for the broken results thumbnails.
 *
 * QA's repro: `/results?q=headphones` on desktop intermittently rendered
 * broken-image frames and logged `Failed to load resource: 403` for
 * `cdn.shopify.com` product photos. The fix routes those photos through the
 * same-origin `/api/image` proxy, which always answers 200 (image or a 1x1
 * miss glyph), and the card's ProxyRetryImage re-requests a missed photo on a
 * backoff, so the browser never sees a failing third-party image and a
 * refusal wave does not leave the grid on grey boxes.
 *
 * What this script proves, against the live box:
 *  1. the served stamp (`/__commit.txt`) and health probe (`/api/health`);
 *  2. `/api/image?u=<shopify url>` answers 200 with an image content-type;
 *  3. four cold loads of `/results?q=headphones` produce ZERO broken images
 *     (every <img> decoded), ZERO image 4xx/5xx and ZERO `Failed to load
 *     resource` console errors;
 *  4. it reports how many cards ended on the proxy's miss glyph after the
 *     retry window (a glyph is not a broken icon, but the photo did not land).
 *
 * Usage: node scripts/verify-reea1128.mjs [baseUrl]
 */
import { chromium } from "playwright-core";

const BASE = (process.argv[2] || process.env.BASE_URL || "https://ns539626.ip-144-217-72.net").replace(/\/$/, "");
const EXEC = process.env.CHROME_PATH || "/opt/ms-playwright/chromium-1194/chrome-linux/chrome";
const SHOPIFY_SAMPLE =
  "https://cdn.shopify.com/s/files/1/0677/2470/6005/files/JBL_Tune_780NC_Wireless_Over-Ear_Adaptive_Noise_Cancelling_Headphones_76H_Playtime.jpg?v=1776607449";
/** Longest client retry is 8 s plus a 2.4 s proxy budget; 25 s covers the
 *  whole backoff ladder before we grade the page. */
const SETTLE_MS = 25_000;

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
    console.log(`proxy: HTTP ${res.status} ${type} ${bytes} bytes miss=${res.headers.get("x-reea-image") ?? "no"}`);
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
  const misses = [];
  const retries = [];
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (/Failed to load resource|403|ERR_/i.test(text)) consoleErrors.push(text);
  });
  page.on("response", (res) => {
    const url = res.url();
    if (!url.includes("/api/image")) return;
    const type = res.headers()["content-type"] ?? "";
    if (type.startsWith("image/") && res.status() >= 400) badImages.push(`${res.status()} ${url.slice(0, 120)}`);
    if (res.headers()["x-reea-image"] === "miss") misses.push(decodeURIComponent(url.split("u=")[1] ?? "").slice(0, 120));
    if (/[?&]r=\d/.test(url)) retries.push(url.slice(0, 120));
  });

  await page.goto(`${BASE}/results?q=headphones`, { waitUntil: "load", timeout: 180_000 });
  // Live offers stream in after the shell; wait until every rendered image is
  // decoded or the client retry ladder has run out.
  const deadline = Date.now() + SETTLE_MS;
  let imgs = [];
  while (Date.now() < deadline) {
    imgs = await page.evaluate(() =>
      Array.from(document.images).map((img) => ({
        src: img.currentSrc || img.src,
        complete: img.complete,
        naturalWidth: img.naturalWidth,
      })),
    );
    if (imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 1)) break;
    await page.waitForTimeout(500);
  }

  const broken = imgs.filter((i) => !i.complete || i.naturalWidth === 0);
  const glyphs = imgs.filter((i) => i.complete && i.naturalWidth === 1);
  console.log(
    `round ${round}: ${imgs.length} images, ${broken.length} broken, ${glyphs.length} still on the miss glyph, ` +
      `${badImages.length} bad responses, ${consoleErrors.length} console errors, ${retries.length} client retries, ${misses.length} proxy misses`,
  );
  for (const b of broken) console.log(`   broken: ${b.src.slice(0, 140)}`);
  for (const g of glyphs) console.log(`   glyph: ${g.src.slice(0, 140)}`);
  for (const b of badImages) console.log(`   bad: ${b}`);
  for (const c of consoleErrors) console.log(`   console: ${c.slice(0, 200)}`);

  note(imgs.length > 0, `round ${round} rendered product images`, `${imgs.length} imgs`);
  note(broken.length === 0, `round ${round} every image decoded`);
  note(badImages.length === 0, `round ${round} no image 4xx/5xx`);
  note(consoleErrors.length === 0, `round ${round} no image console errors`);
  note(glyphs.length === 0, `round ${round} every card shows the product photo`);
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
