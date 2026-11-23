/**
 * REEA-1100 — results-grid CTA age probe.
 *
 * Measures the served /results page at 375x812 and 1280x800 in EN and AR
 * (rc_locale=ar) for the reported query, and gates:
 *   - AC1: zero raw `\d+s ago` tokens in the rendered document, both locales;
 *   - AC2: the lead-card CTA age is humanised/localised (EN just now/min/hr,
 *          AR الآن/قبل…, no Latin "s ago");
 *   - AC3: the age keeps its slot — its layout width fits inside the CTA in
 *          the default (closed disclosure) card and, with the REEA-1096
 *          "Coupons, accessories & details" disclosure open, its rect stays
 *          inside the CTA/card with no horizontal overflow at either width.
 *
 * Usage: BASE_URL=http://127.0.0.1:3210 node scripts/reea1100-probe.mjs
 * Exit code 1 when any gate fails.
 */
import fs from "node:fs";
import { chromium } from "playwright-core";

const base = (process.env.BASE_URL || "http://127.0.0.1:3210").replace(/\/$/, "");
const out = process.env.OUT_DIR || "/tmp/reea1100-probe";
fs.mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: "/opt/ms-playwright/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
});

const report = { base, samples: [], failures: [] };

async function open(locale, width) {
  const ctx = await browser.newContext({
    viewport: { width, height: width === 375 ? 812 : 800 },
    locale: locale === "ar" ? "ar-KW" : "en-US",
    extraHTTPHeaders: { "Accept-Language": locale },
  });
  await ctx.addCookies([{ name: "rc_locale", value: locale, url: base }]);
  return ctx;
}

for (const locale of ["en", "ar"]) {
  for (const width of [375, 1280]) {
    const label = `results-${locale}-${width}`;
    const ctx = await open(locale, width);
    const page = await ctx.newPage();
    page.setDefaultTimeout(60000);
    await page.goto(`${base}/results?q=${encodeURIComponent("iphone 17 pro")}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector(".cta-lead-age", { timeout: 45000, state: "attached" }).catch(() => {});
    await page.waitForTimeout(1500);

    const closed = await page.evaluate(() => {
      const text = document.body.innerText || document.body.textContent || "";
      const raw = text.match(/\b\d+s ago/g) ?? [];
      const ages = [...document.querySelectorAll(".cta-lead-age")].map((el) => {
        const cta = el.closest(".cta-lead");
        const card = el.closest("article");
        // A closed <details> collapses its descendants' layout box to 0, so
        // fall back to the card's width for the slot-fit check.
        const cardWidth = card ? card.getBoundingClientRect().width || card.offsetWidth : 0;
        const ctaWidth = cta ? cta.getBoundingClientRect().width || cta.offsetWidth || cardWidth : cardWidth;
        return {
          text: (el.textContent || "").trim(),
          layoutWidth: el.offsetWidth,
          layoutHeight: el.offsetHeight,
          ctaWidth: Math.round(ctaWidth * 10) / 10,
          closedSlotFits: ctaWidth > 0 && el.offsetWidth > 0 && el.offsetWidth <= ctaWidth,
        };
      });
      return {
        raw,
        rawCount: raw.length,
        ages,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      };
    });

    // REEA-1096 keeps the lead CTA behind a disclosure in the default card.
    // Open it so the visible CTA age can be checked against its slot and the
    // card/viewport edges (the state QA screenshots).
    await page.evaluate(() => {
      for (const d of document.querySelectorAll("details.rc-card-more")) d.open = true;
    });
    await page.waitForTimeout(500);

    const opened = await page.evaluate(() => {
      const ages = [...document.querySelectorAll(".cta-lead-age")].map((el) => {
        const ageRect = el.getBoundingClientRect();
        const cta = el.closest(".cta-lead");
        const ctaRect = cta ? cta.getBoundingClientRect() : null;
        const card = el.closest("article");
        const cardRect = card ? card.getBoundingClientRect() : null;
        return {
          text: (el.textContent || "").trim(),
          rect: {
            left: Math.round(ageRect.left * 10) / 10,
            right: Math.round(ageRect.right * 10) / 10,
            width: Math.round(ageRect.width * 10) / 10,
          },
          insideCta: ctaRect
            ? ageRect.left >= ctaRect.left - 0.5 &&
              ageRect.right <= ctaRect.right + 0.5 &&
              ageRect.bottom <= ctaRect.bottom + 0.5
            : false,
          insideCard: cardRect
            ? ageRect.left >= cardRect.left - 0.5 && ageRect.right <= cardRect.right + 0.5
            : false,
        };
      });
      return { ages, scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth };
    });

    const sample = { label, locale, width, closed, opened };
    report.samples.push(sample);
    await page.screenshot({ path: `${out}/${label}.png`, fullPage: false });
    await ctx.close();

    console.log(
      `== ${label}: raw=${closed.rawCount} ages=${closed.ages.length} scroll=${closed.scrollWidth}/${closed.innerWidth} openedScroll=${opened.scrollWidth}/${opened.innerWidth}`,
    );
    for (const age of closed.ages) console.log(`   closed "${age.text}" layoutWidth=${age.layoutWidth}/${age.ctaWidth}`);
    for (const age of opened.ages) console.log(`   opened "${age.text}" insideCta=${age.insideCta} insideCard=${age.insideCard}`);

    if (closed.rawCount > 0) {
      report.failures.push(`${label}: ${closed.rawCount} raw "\\d+s ago" token(s): ${closed.raw.join(", ")}`);
    }
    if (closed.ages.length === 0) report.failures.push(`${label}: no .cta-lead-age rendered`);
    if (closed.scrollWidth > closed.innerWidth) {
      report.failures.push(`${label}: horizontal overflow (closed) ${closed.scrollWidth} > ${closed.innerWidth}`);
    }
    if (opened.scrollWidth > opened.innerWidth) {
      report.failures.push(`${label}: horizontal overflow (opened) ${opened.scrollWidth} > ${opened.innerWidth}`);
    }
    for (const age of closed.ages) {
      if (locale === "en" && !/just now|min ago|hr ago|day ago/.test(age.text)) {
        report.failures.push(`${label}: EN age "${age.text}" is not humanised`);
      }
      if (locale === "ar" && (!/الآن|قبل/.test(age.text) || /s ago/.test(age.text))) {
        report.failures.push(`${label}: AR age "${age.text}" is not localized`);
      }
      if (!age.closedSlotFits) {
        report.failures.push(
          `${label}: age "${age.text}" layoutWidth ${age.layoutWidth} does not fit its ${age.ctaWidth}px CTA slot`,
        );
      }
    }
    for (const age of opened.ages) {
      if (!age.insideCta) report.failures.push(`${label}: age "${age.text}" escaped its .cta-lead slot`);
      if (!age.insideCard) report.failures.push(`${label}: age "${age.text}" escaped its card`);
    }
  }
}

fs.writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
await browser.close();

if (report.failures.length) {
  console.error(`\nFAIL (${report.failures.length}):`);
  for (const f of report.failures) console.error(`- ${f}`);
  process.exit(1);
}
console.log("\nPASS — no raw seconds; ages humanised/localised, inside the existing CTA slot; no overflow.");
