/**
 * REEA-1255 — EN/AR × 375/1280 screenshots + geometry for the WhatsApp share
 * entry point. Runs against a base URL (defaults to the local production
 * build); the QA/handoff pass points it at the served production host.
 *
 * Usage:
 *   node scripts/reea1255-shots.mjs https://ns539626.ip-144-217-72.net
 *   node scripts/reea1255-shots.mjs http://127.0.0.1:3008
 *
 * Prints, per pass: dir, anchor box (>=44x44 required), horizontal-overflow
 * flag, and the decoded share text. Screenshots land in /tmp/reea1255-*.png.
 */
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const BASE = (process.argv[2] || "http://127.0.0.1:3008").replace(/\/+$/, "");
const QUERY = process.argv[3] || "sony";
const exePath = await chromium.executablePath();
const args = chromium.args.filter((a) => a !== "--single-process");

const passes = [
  { name: "en-375", viewport: { width: 375, height: 900 }, locale: "en-KW", cookies: [["rc_locale", "en"]] },
  { name: "ar-375", viewport: { width: 375, height: 900 }, locale: "ar-KW", cookies: [["rc_locale", "ar"]] },
  { name: "en-1280", viewport: { width: 1280, height: 900 }, locale: "en-KW", cookies: [["rc_locale", "en"]] },
  { name: "ar-1280", viewport: { width: 1280, height: 900 }, locale: "ar-KW", cookies: [["rc_locale", "ar"]] },
];

for (const pass of passes) {
  const browser = await pw.launch({ executablePath: exePath, args, headless: true });
  try {
    const ctx = await browser.newContext({
      viewport: pass.viewport,
      locale: pass.locale,
      colorScheme: "light",
    });
    await ctx.addCookies(pass.cookies.map(([name, value]) => ({ name, value, url: BASE })));
    const page = await ctx.newPage();
    await page.goto(`${BASE}/results?q=${encodeURIComponent(QUERY)}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForSelector("[data-share-whatsapp]", { timeout: 90000 });
    await page.waitForTimeout(1200);
    const probe = await page.evaluate(() => {
      const a = document.querySelector("[data-share-whatsapp]");
      const box = a ? a.getBoundingClientRect() : null;
      const href = a ? a.getAttribute("href") : null;
      const text = href && href.includes("text=") ? decodeURIComponent(href.split("text=")[1]) : null;
      return {
        dir: document.documentElement.dir,
        aria: a ? a.getAttribute("aria-label") : null,
        w: box ? Math.round(box.width) : null,
        h: box ? Math.round(box.height) : null,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        href,
        text,
      };
    });
    await page.screenshot({ path: `/tmp/reea1255-${pass.name}.png` });
    console.log(
      JSON.stringify({
        pass: pass.name,
        dir: probe.dir,
        aria: probe.aria,
        anchor: { w: probe.w, h: probe.h, tapOk: (probe.w ?? 0) >= 44 && (probe.h ?? 0) >= 44 },
        overflow: probe.overflow,
        scrollWidth: probe.scrollWidth,
        innerWidth: probe.innerWidth,
        hrefLen: probe.href?.length ?? null,
        waPrefix: probe.href?.startsWith("https://wa.me/?text=") ?? false,
        text: probe.text,
      }),
    );
  } finally {
    await browser.close();
  }
}
