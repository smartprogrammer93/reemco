/**
 * REEA-1088 local browser probe: prove the strict nonce CSP does not silently
 * block scripts (the REEA-82 failure mode) — /results?q=iphone must hydrate and
 * render real result cards, with no CSP console violations, and a client-only
 * control must actually respond to a click (the strongest hydration evidence).
 *
 * Usage: BASE_URL=http://127.0.0.1:3100 node scripts/reaa1088-probe.mjs
 */
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const BASE = (process.env.BASE_URL || "http://127.0.0.1:3100").replace(/\/$/, "");
const LIB_DIR = "/tmp/al2023/lib";
if (!existsSync(LIB_DIR)) {
  try {
    const tarPath = "/tmp/al2023.tar";
    writeFileSync(
      tarPath,
      brotliDecompressSync(readFileSync(new URL("../node_modules/@sparticuz/chromium/bin/al2023.tar.br", import.meta.url))),
    );
    execSync(`mkdir -p /tmp/al2023 && tar -xf ${tarPath} -C /tmp/al2023`);
  } catch {}
}
process.env.HOME = "/tmp";
process.env.FONTCONFIG_PATH = "/tmp/fonts";
process.env.LD_LIBRARY_PATH = `/tmp/al2023/lib:/tmp/sqlite-extract/usr/lib/x86_64-linux-gnu:/tmp:${process.env.LD_LIBRARY_PATH || ""}`;

const browser = await pw.launch({
  executablePath: await chromium.executablePath(),
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--headless=new"],
  headless: true,
});
const keeper = await browser.newPage();
await keeper.goto("about:blank");
const page = await browser.newPage();
page.setDefaultTimeout(60000);

const consoleErrors = [];
const cspViolations = [];
page.on("console", (m) => {
  const text = m.text();
  if (/content security policy|refused to/i.test(text)) cspViolations.push(text);
  else if (m.type() === "error") consoleErrors.push(text);
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

const resp = await page.goto(`${BASE}/results?q=iphone`, { waitUntil: "load" });
console.log(`GET /results?q=iphone -> HTTP ${resp?.status()}`);
const navCsp = resp?.headers()["content-security-policy"] ?? "";
const navNonce = /'nonce-([A-Za-z0-9+/_-]+={0,2})'/.exec(navCsp)?.[1] ?? null;

let cards = 0;
try {
  await page.waitForFunction(
    () => {
      const nodes = [...document.querySelectorAll(".result-card")];
      return nodes.some((c) => c.getAttribute("aria-hidden") !== "true" && c.querySelector("a[href]"));
    },
    { timeout: 60000 },
  );
  cards = await page.$$eval(".result-card", (els) =>
    els.filter((c) => c.getAttribute("aria-hidden") !== "true" && c.querySelector("a[href]")).length,
  );
} catch (e) {
  const skeletons = await page.$$eval(".result-card", (els) => els.length);
  console.log(`NO HYDRATED CARDS: ${skeletons} card node(s), error=${e.message}`);
}

const runtime = await page.evaluate(() => ({
  nextFlight: Array.isArray(window.__next_f),
  scriptNonces: [...new Set([...document.querySelectorAll("script[nonce]")].map((s) => s.nonce))],
}));

// Hydration proof: a client-only in-place control must respond to a real click.
// A blocked script leaves the button inert; a full document reload would drop
// the marker we set on window before clicking.
const toggle = page.locator('[role="checkbox"]').first();
const before = await toggle.getAttribute("aria-checked");
await page.evaluate(() => {
  window.__reea1088Marker = 1;
});
await toggle.click();
await page.waitForTimeout(500);
const after = await toggle.getAttribute("aria-checked");
const survivedReload = await page.evaluate(() => window.__reea1088Marker === 1);

console.log(`hydrated real result cards: ${cards}`);
console.log("runtime:", JSON.stringify(runtime));
console.log(`toggle aria-checked: ${before} -> ${after} (no document reload: ${survivedReload})`);
console.log("navigation CSP nonce:", navNonce);
console.log("CSP violations:", cspViolations.length ? cspViolations.slice(0, 5) : "none");
console.log("console errors:", consoleErrors.length ? consoleErrors.slice(0, 5) : "none");

await browser.close();

const ok =
  resp?.status() === 200 &&
  cards >= 1 &&
  runtime.nextFlight &&
  runtime.scriptNonces.length === 1 &&
  navNonce !== null &&
  runtime.scriptNonces[0] === navNonce &&
  before !== after &&
  survivedReload &&
  cspViolations.length === 0 &&
  consoleErrors.length === 0;
console.log(ok ? "PROBE PASSED" : "PROBE FAILED");
process.exit(ok ? 0 : 1);
