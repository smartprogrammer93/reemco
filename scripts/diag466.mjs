// One-shot diagnostic for the REEA-466 gate harness: does a results
// navigation reach rendered offer cards + heading within ~8s, and what does
// the document look like at the sample points? Mirrors the harness launch
// (chromium + vendored libs) so results match scripts/reea466-gate.mjs.
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const BASE = "https://reemco.vercel.app";
const LIB_DIR = "/tmp/al2023/lib";
if (!existsSync(LIB_DIR)) {
  try {
    writeFileSync("/tmp/al2023.tar", brotliDecompressSync(readFileSync(new URL("../node_modules/@sparticuz/chromium/bin/al2023.tar.br", import.meta.url))));
    execSync("mkdir -p /tmp/al2023 && tar -xf /tmp/al2023.tar -C /tmp/al2023");
  } catch {}
}
if (existsSync(LIB_DIR)) {
  try { execSync(`cp -f scripts/vendor/libsqlite3.so.0 scripts/vendor/libc.musl-x86_64.so.1 scripts/vendor/libnssckbi.so ${LIB_DIR}/`); } catch {}
}
process.env.HOME = "/tmp";
process.env.FONTCONFIG_PATH = "/tmp/fonts";
process.env.LD_LIBRARY_PATH = [LIB_DIR, "/tmp/sqlite-extract/usr/lib/x86_64-linux-gnu", "/tmp", process.env.LD_LIBRARY_PATH || ""].filter(Boolean).join(":");

const browser = await pw.launch({
  executablePath: await chromium.executablePath(),
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--headless=new"],
  headless: true,
});
const page = await browser.newPage();
page.setDefaultTimeout(30000);

const t0 = Date.now();
await page.goto(`${BASE}/`, { waitUntil: "load", timeout: 30000 }).catch((e) => console.log("home err", e.message));
await page.waitForSelector("header a[href='/']", { timeout: 15000 }).catch(() => console.log("home: header link not found"));
console.log("home prewarm at", Date.now() - t0, "ms, title:", await page.title());

for (const q of ["iPhone 17 Pro", "vvxq 90210 zxty"]) {
  const s0 = Date.now();
  await page.goto(`${BASE}/results?q=${encodeURIComponent(q)}`, { waitUntil: "domcontentloaded", timeout: 30000 }).catch((e) => console.log("nav err", e.message));
  const samples = [];
  for (let i = 0; i < 16; i++) {
    const snap = await page.evaluate(() => {
      const cards = document.querySelectorAll("article.result-card");
      let vis = 0;
      cards.forEach((c) => { const a = c.getAttribute("aria-hidden"); if (a !== "true" && a !== "") vis++; });
      const tab = document.querySelector("h1 .tabular, span.tabular");
      return { vis, total: cards.length, heading: tab ? tab.textContent.trim() : null, bodyLen: document.body.innerHTML.length, title: document.title };
    }).catch((e) => ({ err: String(e).slice(0, 80) }));
    samples.push(`${Date.now() - s0}ms ${JSON.stringify(snap)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`QUERY ${q} (window ${Date.now() - s0}ms)`);
  samples.forEach((s) => console.log(" ", s));
}
await browser.close();
