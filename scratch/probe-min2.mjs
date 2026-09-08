import { chromium as pw } from "playwright-core";
process.env.HOME = "/tmp";
process.env.FONTCONFIG_PATH = "/tmp/fonts";
process.env.LD_LIBRARY_PATH = `/tmp/lib/lib:/tmp:${process.env.LD_LIBRARY_PATH || ""}`;
const browser = await pw.launch({ executablePath: "/tmp/chromium", args: ["--no-sandbox","--disable-dev-shm-usage","--disable-gpu"] });
const ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
const page = await ctx.newPage();
page.on("close", () => console.log("page closed"));
try { await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 30000 }); console.log("title:", await page.title()); } catch (e) { console.log("ERR", String(e).slice(0,200)); }
await browser.close();
