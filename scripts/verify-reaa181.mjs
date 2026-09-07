/**
 * REEA-181 verification: footer links reach real About/Privacy/Contact pages.
 * Checks, against BASE: HTTP status per route, server-rendered copy in the
 * first HTML paint, footer href targets, mobile fit at 375x667 (no horizontal
 * overflow), aria-current behavior, and writes screenshots as evidence.
 * Usage: VERIFY_BASE_URL=http://127.0.0.1:3217 node scripts/verify-reaa181.mjs
 * Exit 0 = PASS. Bootstrap follows scripts/smoke-check.mjs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const BASE = (process.env.VERIFY_BASE_URL || "http://127.0.0.1:3217").replace(/\/$/, "");
const SHOT_DIR = process.env.VERIFY_SHOTS || "/work/reaa181";

// Same chromium bootstrap as scripts/smoke-check.mjs: extract the bundled
// NSS/sqlite libs and point LD_LIBRARY_PATH at them before spawning.
const LIB_DIR = "/tmp/al2023/lib";
const VENDOR_DIR = new URL("./vendor/", import.meta.url);
if (!existsSync(LIB_DIR)) {
  try {
    writeFileSync(
      "/tmp/al2023.tar",
      brotliDecompressSync(readFileSync(new URL("../node_modules/@sparticuz/chromium/bin/al2023.tar.br", import.meta.url))),
    );
    execSync(`mkdir -p /tmp/al2023 && tar -xf /tmp/al2023.tar -C /tmp/al2023`);
  } catch {
    // System chromium libs may already be present.
  }
}
if (existsSync(LIB_DIR)) {
  try {
    for (const f of ["libsqlite3.so.0", "libc.musl-x86_64.so.1", "libnssckbi.so"]) {
      const src = new URL(f, VENDOR_DIR);
      if (existsSync(src)) execSync(`cp -f ${decodeURIComponent(src.pathname)} ${LIB_DIR}/`);
    }
  } catch {
    // Vendored extras are optional when the host already provides equivalents.
  }
}
process.env.HOME = "/tmp";
process.env.FONTCONFIG_PATH = "/tmp/fonts";
process.env.LD_LIBRARY_PATH = `${LIB_DIR}:/tmp/sqlite-extract/usr/lib/x86_64-linux-gnu:/tmp:${process.env.LD_LIBRARY_PATH || ""}`;

const failures = [];
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

// Expected server-rendered content per route (first paint must contain it).
const EXPECT = {
  "/about": { h1: "About Reemco", phrases: ["price-comparison site for shopping in Kuwait", "fetched live from each retailer"] },
  "/privacy": { h1: "Privacy", phrases: ["what Reemco records, and why", "anonymous counts and click-outs"] },
  "/contact": { h1: "Contact", phrases: ["Email us", "support@reemco.example", "reply within one business day"] },
};

mkdirSync(SHOT_DIR, { recursive: true });

const browser = await pw.launch({
  executablePath: await chromium.executablePath(),
  args: [...chromium.args, "--headless=new"],
  headless: true,
});
const keeper = await browser.newPage();
await keeper.goto("about:blank");

console.log(`REEA-181 verify against ${BASE}`);

// 1) Plain HTTP status + server-rendered HTML content per route.
const statuses = {};
for (const [route, exp] of Object.entries(EXPECT)) {
  const url = `${BASE}${route}`;
  const res = await fetch(url);
  const html = await res.text();
  statuses[route] = res.status;
  check(`${route} returns HTTP 200`, res.status === 200, `got ${res.status}`);
  check(`${route} h1 present in first HTML paint`, html.includes(exp.h1));
  for (const p of exp.phrases) {
    check(`${route} contains "${p.slice(0, 40)}..."`, html.includes(p));
  }
}

// One shared working page (plus the keeper) — with --single-process the
// bundled chromium is happiest with a stable page set; qa-verify.mjs uses the
// same keeper pattern.
const page = await browser.newPage();

// 2) Footer links on "/" point at the real routes (not "/").
{
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  const hrefs = await page.$$eval("nav[aria-label='Footer'] a", (as) =>
    as.map((a) => [a.getAttribute("href"), a.textContent.trim()])
  );
  check(
    "footer hrefs are /about /privacy /contact",
    JSON.stringify(hrefs) ===
      JSON.stringify([["/about", "About"], ["/privacy", "Privacy"], ["/contact", "Contact"]]),
    JSON.stringify(hrefs)
  );
}

// 3) Mobile fit at 375x667: h1 visible, no horizontal overflow; screenshot /about.
await page.setViewportSize({ width: 375, height: 667 });
for (const route of Object.keys(EXPECT)) {
  await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
  const m = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    h1: document.querySelector("main h1")?.textContent?.trim() ?? "",
    ariaCurrent: [...document.querySelectorAll("nav[aria-label='Footer'] a")].map(
      (a) => `${a.textContent.trim()}=${a.getAttribute("aria-current") ?? ""}`
    ),
  }));
  check(`${route} no horizontal overflow at 375px`, m.scrollW <= m.clientW + 1, `scrollW=${m.scrollW} clientW=${m.clientW}`);
  const wantH1 = EXPECT[route].h1;
  check(`${route} visible h1 is "${wantH1}"`, m.h1 === wantH1, `got "${m.h1}"`);
  const label = route.slice(1).toLowerCase();
  const marked = m.ariaCurrent.filter((s) => s.endsWith("=page"));
  check(
    `${route} aria-current='page' only on the matching label`,
    marked.length === 1 && marked[0].toLowerCase().startsWith(label),
    JSON.stringify(m.ariaCurrent)
  );
  if (route === "/about") {
    await page.screenshot({ path: `${SHOT_DIR}/about-375.png`, fullPage: true });
  }
}

// 4) One desktop screenshot of each page for the visual record.
{
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const route of Object.keys(EXPECT)) {
    await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded" });
    await page.screenshot({ path: `${SHOT_DIR}${route}-1280.png`, fullPage: true });
  }
}

await browser.close();

console.log(`statuses: ${JSON.stringify(statuses)}`);
console.log(`screenshots in ${SHOT_DIR}`);
if (failures.length) {
  console.error(`REEA-181 VERIFY FAILED (${failures.length}): ${failures.join("; ")}`);
  process.exit(1);
}
console.log("REEA-181 VERIFY PASSED");
