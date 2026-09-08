import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";
if (!existsSync("/tmp/al2023/lib")) {
  const tarPath = "/tmp/al2023.tar";
  writeFileSync(tarPath, brotliDecompressSync(readFileSync(new URL("./node_modules/@sparticuz/chromium/bin/al2023.tar.br", import.meta.url))));
  execSync(`mkdir -p /tmp/al2023 && tar -xf ${tarPath} -C /tmp/al2023`);
}
process.env.LD_LIBRARY_PATH = `/tmp/al2023/lib:${process.env.LD_LIBRARY_PATH || ""}`;
const browser = await pw.launch({ executablePath: await chromium.executablePath(), headless: true, args: ["--no-sandbox","--disable-dev-shm-usage","--disable-gpu"] });
const page = await browser.newPage();
page.setDefaultTimeout(30000);
const t0 = Date.now();
await page.goto("https://reemco.vercel.app/results?q=sony", { waitUntil: "load" });
await page.waitForSelector(".result-card", { timeout: 25000 });
console.log(`TIMING results load (incl. hydration): ${Date.now() - t0}ms`);
await browser.close();
