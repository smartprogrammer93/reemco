/**
 * REEA-126 contract probe: capture the real network calls the Sultan Center
 * SPA makes for a product search, so the adapter ships the documented
 * contract (POST mobile/api/search) with the exact payload/response shape.
 * Usage: node scripts/probe-sultan.mjs [query]
 */
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

process.env.HOME = "/tmp";
process.env.FONTCONFIG_PATH = "/tmp/fonts";
if (!existsSync("/tmp/al2023/lib")) {
  try {
    writeFileSync(
      "/tmp/al2023.tar",
      brotliDecompressSync(
        readFileSync(new URL("../node_modules/@sparticuz/chromium/bin/al2023.tar.br", import.meta.url)),
      ),
    );
    execSync("mkdir -p /tmp/al2023 && tar -xf /tmp/al2023.tar -C /tmp/al2023");
  } catch {
    // Host may already provide the shared libs.
  }
}
process.env.LD_LIBRARY_PATH = `/tmp/al2023/lib:/tmp:${process.env.LD_LIBRARY_PATH || ""}`;

const query = process.argv[2] || "air fryer";
const browser = await pw.launch({
  executablePath: await chromium.executablePath(),
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--headless=new"],
  headless: true,
});
const keeper = await browser.newPage();
await keeper.goto("about:blank");
const page = await browser.newPage();
page.setDefaultTimeout(30000);

const captured = [];
page.on("request", (req) => {
  if (!req.url().includes("/mobile/api/")) return;
  console.log(`REQ ${req.method()} ${req.url()}`);
  console.log(`  headers: ${JSON.stringify(req.headers())}`);
  console.log(`  body: ${req.postData() ?? ""}`);
});
page.on("response", async (res) => {
  const ct = res.headers()["content-type"] || "";
  if (!ct.includes("json")) return;
  try {
    const body = await res.text();
    captured.push({ url: res.url(), status: res.status(), body: body.slice(0, 4000) });
  } catch {
    /* ignore */
  }
});

await page.goto(`https://www.sultan-center.com/sultansearchs?q=${encodeURIComponent(query)}`, {
  waitUntil: "load",
});
await page.waitForTimeout(6000);
const cards = await page.$$eval(".product-card, .ProductCard, [class*=product]", (els) =>
  els.slice(0, 5).map((e) => `${e.className}: ${(e.textContent || "").trim().slice(0, 120)}`),
);

console.log("== JSON responses ==");
for (const c of captured) {
  console.log(`--- ${c.status} ${c.url}`);
  console.log(c.body.slice(0, 1800));
}
console.log("== rendered snippets ==");
console.log(cards.join("\n"));
await browser.close();
