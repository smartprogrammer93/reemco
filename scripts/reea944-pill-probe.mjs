// REEA-944 verification probe — pending-pill containment per the REEA-863 spec.
// Measures the live-served pending pill (.best-flag-pending) against its lead
// card at 1280x900 (EN + AR via rc_locale cookie) and 390px (no-regression),
// on cold queries right after server start.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import chromium from "@sparticuz/chromium";
import { chromium as pw } from "playwright-core";

const BASE = "http://localhost:3123";
const LIB_DIR = "/tmp/al2023/lib";
if (!existsSync("/tmp/al2023")) {
  try {
    const tarPath = "/tmp/al-chromium.tar";
    writeFileSync(tarPath, brotliDecompressSync(readFileSync("/work/reemco-price-compare/node_modules/@sparticuz/chromium/bin/al2023.tar.br")));
    execSync(`mkdir -p /tmp/al2023 && tar -xf ${tarPath} -C /tmp/al2023`);
  } catch { /* host libs may already exist */ }
}
process.env.HOME = "/tmp";
process.env.FONTCONFIG_PATH = "/tmp/fonts";
process.env.LD_LIBRARY_PATH = [LIB_DIR, "/tmp", process.env.LD_LIBRARY_PATH || ""].filter(Boolean).join(":");

const browser = await pw.launch({
  executablePath: await chromium.executablePath(),
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--headless=new"],
  headless: true,
});

const measure = async ({ label, path, cookie, viewport, shot }) => {
  const page = await browser.newPage({ viewport });
  if (cookie) await page.context().addCookies([{ name: "rc_locale", value: cookie, url: BASE }]);
  // Cold query: the SSR flush carries the pending pill while the Kuwait batch
  // is in flight. Wait only for DOM, then measure immediately — the settle
  // swap must not beat the probe.
  await page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 30000 });
  // CSS chunks hydrate after DCL in this Next runtime — wait until the pill's
  // containment CSS is actually applied (or the pill settled away).
  await page
    .waitForFunction(
      () => {
        const el = document.querySelector(".best-flag-pending");
        return !el ? document.readyState === "complete" : getComputedStyle(el).overflow === "hidden";
      },
      { timeout: 20000 },
    )
    .catch(() => {});
  const res = await page.evaluate(() => {
    const pill = document.querySelector(".best-flag-pending");
    const settledFlag = document.querySelector(".best-flag:not(.best-flag-pending)");
    if (!pill) return { pending: false, settledFlag: !!settledFlag, cards: document.querySelectorAll(".result-card").length };
    const card = pill.closest(".result-card");
    const pr = pill.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    const bdi = pill.querySelector("bdi");
    const style = getComputedStyle(pill);
    const bdiStyle = getComputedStyle(bdi);
    // the conversion figure on the same row
    const row = pill.parentElement;
    const alt = row.querySelector(".price-alt");
    const ar = alt ? alt.getBoundingClientRect() : null;
    const sameLine = ar ? Math.abs(ar.top - pr.top) < Math.max(pr.height, ar.height) * 0.7 : false;
    const gap = ar && sameLine ? (getComputedStyle(row).direction === "rtl"
      ? pr.left - ar.right
      : ar.left - pr.right) : null;
    return {
      pending: true,
      dir: getComputedStyle(row).direction,
      pillClass: pill.className,
      parentClass: row.className,
      grandparentClass: row.parentElement?.className,
      pillComputed: {
        minWidth: style.minWidth,
        overflow: style.overflow,
        whiteSpace: style.whiteSpace,
        flexWrap: style.flexWrap,
      },
      sheets: document.styleSheets.length,
      pillRect: { l: +pr.left.toFixed(1), r: +pr.right.toFixed(1), t: +pr.top.toFixed(1), w: +pr.width.toFixed(1) },
      altRect: ar ? { l: +ar.left.toFixed(1), r: +ar.right.toFixed(1), t: +ar.top.toFixed(1), w: +ar.width.toFixed(1) } : null,
      sameLine,
      cardRect: { l: +cr.left.toFixed(1), r: +cr.right.toFixed(1), w: +cr.width.toFixed(1) },
      overflowRight: +(pr.right - cr.right).toFixed(1),
      overflowLeft: +(cr.left - pr.left).toFixed(1),
      gapToConversion: gap == null ? null : +gap.toFixed(1),
      ellipsis: {
        pillTextOverflow: style.textOverflow,
        bdiTextOverflow: bdiStyle.textOverflow,
        bdiClipped: bdi.scrollWidth > bdi.clientWidth + 1,
      },
      title: pill.getAttribute("title"),
      rowWrap: getComputedStyle(row).flexWrap,
      pillFlex: style.flex,
      text: pill.textContent.trim(),
    };
  });
  if (res.pending) await page.screenshot({ path: shot, clip: { x: 0, y: 0, width: viewport.width, height: Math.min(560, viewport.height) } }).catch(() => {});
  await page.close();
  return { label, ...res };
};

const out = {};
// EN 1280x900 cold
out.en1280 = await measure({ label: "EN 1280", path: "/results?q=dyson%20v15%20cordless%20vacuum%20cleaner", viewport: { width: 1280, height: 900 }, shot: "/work/reea944-en-1280.png" });
// AR 1280x900 cold (rc_locale cookie)
out.ar1280 = await measure({ label: "AR 1280", path: "/results?q=kindle%20paperwhite%20signature%2032gb%20ereader", cookie: "ar", viewport: { width: 1280, height: 900 }, shot: "/work/reea944-ar-1280.png" });
// no-regression: 390px EN — fresh cold query so the pending window is live
out.en390 = await measure({ label: "EN 390", path: "/results?q=galaxy%20s25%20ultra", viewport: { width: 390, height: 844 }, shot: "/work/reea944-en-390.png" });

console.log(JSON.stringify(out, null, 1));
await browser.close();
