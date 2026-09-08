import { chromium as pw } from "playwright-core";
import http from "node:http";
process.env.HOME = "/tmp";
process.env.FONTCONFIG_PATH = "/tmp/fonts";
process.env.LD_LIBRARY_PATH = `/tmp/lib/lib:/tmp:${process.env.LD_LIBRARY_PATH || ""}`;
const srv = http.createServer((req, res) => { res.setHeader("content-type","text/html"); res.end("<!doctype html><h1>hi</h1>"); });
await new Promise(r => srv.listen(3457, "127.0.0.1", r));
const browser = await pw.launch({ executablePath: "/tmp/chromium", args: ["--no-sandbox","--disable-dev-shm-usage","--disable-gpu"] });
const ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
const page = await ctx.newPage();
try { await page.goto("http://127.0.0.1:3457/", { waitUntil: "domcontentloaded", timeout: 30000 }); console.log("title:", await page.title()); } catch (e) { console.log("ERR", String(e).slice(0,160)); }
await browser.close(); srv.close();
