// REEA-116 end-to-end check: "Go to store" hrefs on the deployed product page
// must be direct retailer product URLs (Bing SERP only when no product URL
// was captured). Same chromium bootstrap as smoke-check.mjs.
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const BASE = (process.env.BASE || "https://reemco.vercel.app").replace(/\/$/, "");

const LIB_DIR = "/tmp/al2023/lib";
const VENDOR_DIR = new URL("./vendor/", "file:///work/reemco-price-compare/scripts/");
if (!existsSync(LIB_DIR)) {
  try {
    const tarPath = "/tmp/al2023.tar";
    writeFileSync(tarPath, brotliDecompressSync(readFileSync("/work/reemco-price-compare/node_modules/@sparticuz/chromium/bin/al2023.tar.br")));
    execSync(`mkdir -p /tmp/al2023 && tar -xf ${tarPath} -C /tmp/al2023`);
  } catch {}
}
if (existsSync(LIB_DIR)) {
  try {
    for (const f of ["libsqlite3.so.0", "libc.musl-x86_64.so.1", "libnssckbi.so"]) {
      const src = new URL(f, VENDOR_DIR);
      if (existsSync(src)) execSync(`cp -f ${decodeURIComponent(src.pathname)} ${LIB_DIR}/`);
    }
  } catch {}
  process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH ? `${LIB_DIR}:${process.env.LD_LIBRARY_PATH}` : LIB_DIR;
}

const browser = await pw.launch({
  executablePath: await chromium.executablePath(),
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  headless: true,
});
browser.on("disconnected", () => console.log("(browser disconnected)"));
let out = { links: [], anchors: -1, note: "" };
try {
  const page = await browser.newPage();
  await page.route("**/*", (r) => {
    const t = r.request().resourceType();
    r.continue({ headers: { ...r.request().headers(), accept: "*/*" } });
  });
  const url = `${BASE}/product/asus-rog-strix-scope-ii`;
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  console.log("goto:", resp && resp.status(), url);
  await page.waitForSelector("main a", { timeout: 20000 }).catch(() => {});
  // Give the live collect job time to settle, then read anchors in one shot.
  await new Promise((r) => setTimeout(r, 12000));
  out = await page.evaluate(() => {
    const anchors = [...document.querySelectorAll("a")];
    return {
      anchors: anchors.length,
      links: anchors
        .filter((a) => /go to store/i.test(a.textContent || ""))
        .map((a) => a.getAttribute("href")),
      note: document.body.innerText.slice(0, 400),
    };
  });
} catch (e) {
  console.log("ERR:", String(e).split("\n")[0]);
}
try { await browser.close(); } catch {}

let bad = 0;
console.log("anchors on page:", out.anchors, "| go-to-store links:", out.links.length);
for (const h of out.links) {
  const serp = /^https:\/\/www\.bing\.com\/search/.test(h || "");
  if (serp) bad++;
  console.log(` - ${h}${serp ? "   [SERP]" : ""}`);
}
console.log("note:", out.note.replace(/\s+/g, " ").slice(0, 300));
console.log(out.links.length > 0 && bad === 0 ? "RESULT PASS" : `RESULT FAIL (links=${out.links.length} serp=${bad})`);
process.exit(out.links.length > 0 && bad === 0 ? 0 : 1);
