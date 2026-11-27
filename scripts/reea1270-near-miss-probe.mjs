/**
 * REEA-1270 — near-miss panel + committed zero-offer replay probe (local or
 * served base). Reports, per query/viewport/locale: cards, the labelled
 * correction line (R-2), the recovery band, first-card ms and overflow.
 */
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const PANEL = ["iphon 17 pro","samsng s25","whirpool microwave","reciever","airpod pro","nintindo switch 2","dyson airwarp","jbl tune 520bt","xiaomi 15 pro","samsung washing mashine"];
const REPLAY = ["xyzzy no such thing","sony wh-1000xm6 ear pads","apple pencil pro tips","dyson airwrap case","kindle paperwhite cover","zzzzqqq"];
const WIDTHS = (process.env.WIDTHS || "375").split(",").map(Number);
const LOCALES = (process.env.LOCALES || "en,ar").split(",");
const SET = process.env.SET === "replay" ? REPLAY : PANEL;

const LIB_DIR = "/tmp/al2023/lib";
if (!existsSync(LIB_DIR)) {
  writeFileSync("/tmp/al2023.tar", brotliDecompressSync(readFileSync(new URL("../node_modules/@sparticuz/chromium/bin/al2023.tar.br", import.meta.url))));
  execSync("mkdir -p /tmp/al2023 && tar -xf /tmp/al2023.tar -C /tmp/al2023");
}
process.env.HOME = "/tmp";
process.env.FONTCONFIG_PATH = "/tmp/fonts";
process.env.LD_LIBRARY_PATH = [LIB_DIR, "/tmp/sqlite-extract/usr/lib/x86_64-linux-gnu", "/tmp"].join(":");

const browser = await pw.launch({ executablePath: await chromium.executablePath(), args: ["--no-sandbox","--disable-dev-shm-usage","--disable-gpu","--headless=new"], headless: true });
const rows = [];
for (const q of SET) for (const width of WIDTHS) for (const loc of LOCALES) {
  const ctx = await browser.newContext({ viewport: { width, height: width === 375 ? 812 : 900 }, locale: loc === "ar" ? "ar-KW" : "en-KW" });
  if (loc === "ar") await ctx.addCookies([{ name: "rc_locale", value: "ar", url: BASE }]);
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(`${BASE}/results?q=${encodeURIComponent(q)}&market=KW`, { waitUntil: "domcontentloaded", timeout: 120000 });
  let firstCardMs = null;
  try { await page.waitForSelector('article.result-card:not([aria-hidden])', { timeout: 20000 }); firstCardMs = Date.now() - t0; } catch {}
  await page.waitForTimeout(4500);
  const data = await page.evaluate(() => {
    const norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();
    const line = document.querySelector("[data-near-miss-correction]");
    return {
      cards: document.querySelectorAll('article.result-card:not([aria-hidden])').length,
      line: line ? { from: line.getAttribute("data-near-miss-from"), to: line.getAttribute("data-near-miss-to"), text: norm(line.textContent) } : null,
      empty: !!document.querySelector('[data-empty-state="true"]'),
      recovery: document.querySelectorAll("[data-recovery-item]").length,
      foreign: document.querySelectorAll("[data-foreign-item]").length,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
  rows.push({ q, width, loc, firstCardMs, ...data });
  console.log(`${q} ${width}/${loc}: cards=${data.cards} empty=${data.empty} line=${data.line ? data.line.to : "-"} recovery=${data.recovery} first=${firstCardMs} overflow=${data.overflow}`);
  await ctx.close();
}
await browser.close();
const zero = rows.filter((r) => r.empty || r.cards === 0);
const recovered = zero.filter((r) => r.recovery > 0);
const named = rows.filter((r) => r.line);
console.log(`\nSET=${SET === PANEL ? "panel" : "replay"} rows=${rows.length} zero=${zero.length} recovered=${recovered.length} recoveryRate=${zero.length ? ((recovered.length / zero.length) * 100).toFixed(1) : "n/a"}% named=${named.length} overflow=${rows.filter(r=>r.overflow).length}`);
writeFileSync(process.env.OUT || "/tmp/reea1270-probe.json", JSON.stringify({ base: BASE, set: SET === PANEL ? "panel" : "replay", rows }, null, 2));
