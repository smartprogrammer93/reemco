import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const b = await pw.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
const ctx = await b.newContext({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" });
const page = await ctx.newPage();
for (const u of ["https://www.nextstore.com.kw/catalogsearch/result/index/?q=dell+laptop", "https://www.luluhypermarket.com/en/search?query=basmati+rice"]) {
  const t0 = Date.now();
  await page.goto(u, { waitUntil: "domcontentloaded", timeout: 30000 });
  const html = await page.content();
  const cookies = await ctx.cookies();
  console.log(u, "->", html.length, "B in", Date.now() - t0, "ms; cookies:", cookies.map(c => c.name).join(","), "; ldjson blocks:", (html.match(/application\/ld\+json/g) || []).length, "; product links:", (html.match(/product-item-link|product-box|ProductCard/g) || []).length);
}
// Dump the clearance cookies for reuse in plain fetch:
const jar = await ctx.cookies();
console.log("JAR:", JSON.stringify(jar.map(c => `${c.name}=${c.value}`)));
await b.close();
