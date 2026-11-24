import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";
const BASE = "http://127.0.0.1:3005";
const exePath = await chromium.executablePath();
const args = chromium.args.filter((a) => a !== "--single-process");
async function shot(name, viewport, locale, cookies) {
  const b = await pw.launch({ executablePath: exePath, args, headless: true });
  const ctx = await b.newContext({ viewport, locale, colorScheme: "light" });
  await ctx.addCookies(cookies.map(([n, v]) => ({ name: n, value: v, url: BASE })));
  const p = await ctx.newPage();
  await p.goto(`${BASE}/about`, { waitUntil: "networkidle", timeout: 40000 });
  await p.screenshot({ path: `/tmp/${name}.png` });
  await b.close();
  console.log("shot", name);
}
await shot("theme-en-375-dark", { width: 375, height: 900 }, "en-KW", [["rc_theme", "dark"]]);
await shot("theme-ar-375-dark", { width: 375, height: 900 }, "ar-KW", [["rc_locale", "ar"], ["rc_theme", "dark"]]);
await shot("theme-en-1280-dark", { width: 1280, height: 900 }, "en-KW", [["rc_theme", "dark"]]);
