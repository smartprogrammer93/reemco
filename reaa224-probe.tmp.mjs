// Probe: why is one retailer row taller at 1280, and why does the button
// sit off-center on some rows at 480? Dump row/cluster internals.
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";

const LIB_DIR = "/tmp/al2023/lib";
if (!existsSync(LIB_DIR)) {
  try {
    writeFileSync("/tmp/al2023.tar", brotliDecompressSync(readFileSync("/work/reemco-price-compare/node_modules/@sparticuz/chromium/bin/al2023.tar.br")));
    execSync(`mkdir -p /tmp/al2023 && tar -xf /tmp/al2023.tar -C /tmp/al2023`);
  } catch {}
}
if (existsSync(LIB_DIR)) {
  try { execSync(`cp -f /work/reemco-price-compare/scripts/vendor/libsqlite3.so.0 /work/reemco-price-compare/scripts/vendor/libc.musl-x86_64.so.1 /work/reemco-price-compare/scripts/vendor/libnssckbi.so ${LIB_DIR}/`); } catch {}
}
process.env.HOME = "/tmp";
process.env.FONTCONFIG_PATH = "/tmp/fonts";
process.env.LD_LIBRARY_PATH = [LIB_DIR, "/tmp/sqlite-extract/usr/lib/x86_64-linux-gnu", "/tmp"].join(":");

const probe = () => {
  const cards = [...document.querySelectorAll("article.result-card")].slice(0, 3);
  return cards.map((card) =>
    [...card.querySelectorAll('section[aria-label="Prices and availability by retailer"] li')].map((li) => {
      const lr = li.getBoundingClientRect();
      const kids = [...li.children].map((k) => {
        const kr = k.getBoundingClientRect();
        return { cls: (k.className || "").slice(0, 40), h: Math.round(kr.height * 10) / 10, text: (k.textContent || "").trim().slice(0, 60) };
      });
      const btn = li.querySelector(".btn-primary");
      const br = btn ? btn.getBoundingClientRect() : null;
      return {
        liH: Math.round(lr.height * 10) / 10,
        kids,
        btn: br ? { top: Math.round((br.top - lr.top) * 10) / 10, h: Math.round(br.height * 10) / 10 } : null,
      };
    }),
  );
};

const browser = await pw.launch({
  executablePath: await chromium.executablePath(),
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--headless=new"],
  headless: true,
});
const keeper = await browser.newPage();
await keeper.goto("about:blank");
const page = await browser.newPage();
page.setDefaultTimeout(30000);

await page.setViewportSize({ width: 1280, height: 900 });
await page.goto(`https://reemco.vercel.app/results?q=${encodeURIComponent("iPhone 17 Pro Max")}`, { waitUntil: "load" });
await page.waitForSelector('section[aria-label="Prices and availability by retailer"] li', { timeout: 15000 });
console.log("WIDTH1280", JSON.stringify(await page.evaluate(probe), null, 1));

await page.setViewportSize({ width: 480, height: 900 });
await page.waitForTimeout(300);
console.log("WIDTH480", JSON.stringify(await page.evaluate(probe), null, 1));

await browser.close();
