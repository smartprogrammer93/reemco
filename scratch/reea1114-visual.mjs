import pw from 'playwright-core';
import chrome from '@sparticuz/chromium';

const BASE = process.env.BASE || 'http://localhost:3000';
const Q = process.env.Q || 'panadol';

async function run(locale, width) {
  const browser = await pw.chromium.launch({ executablePath: await chrome.executablePath(), args: chrome.args });
  const ctx = await browser.newContext({
    viewport: { width, height: 1000 },
    locale: locale === 'ar' ? 'ar-KW' : 'en-KW',
    extraHTTPHeaders: { 'Accept-Language': locale === 'ar' ? 'ar-KW,ar;q=0.9' : 'en-KW,en;q=0.9' },
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message.slice(0, 200)));
  await page.goto(`${BASE}/results?q=${encodeURIComponent(Q)}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(
    () => document.querySelector('[data-empty-state="true"]') || document.querySelectorAll('article.result-card').length > 0,
    null,
    { timeout: 30000 },
  ).catch(() => {});
  await page.waitForTimeout(800);
  const info = await page.evaluate(() => {
    const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);
    const empty = document.querySelector('[data-empty-state="true"]');
    const chips = Array.from(document.querySelectorAll('.rc-filter-bar button')).map((b) => {
      const r = b.getBoundingClientRect();
      const visible = (el) => el && getComputedStyle(el).display !== 'none';
      return {
        text: txt(b),
        visibleText: Array.from(b.childNodes).map((n) => n.nodeType === 3 ? n.textContent : (visible(n) ? n.textContent : '')).join('').replace(/\s+/g,' ').trim(),
        pressed: b.getAttribute('aria-pressed'),
        rect: { x: Math.round(r.x), w: Math.round(r.width), right: Math.round(r.right) },
        clipped: b.scrollWidth > b.clientWidth + 1,
        overflowViewport: r.right > window.innerWidth + 1 || r.x < -1,
      };
    });
    const cardOverflow = empty
      ? Array.from(empty.querySelectorAll('*')).filter((el) => {
          if (el.classList.contains('sr-only')) return false;
          const r = el.getBoundingClientRect();
          return r.right > window.innerWidth + 1 || r.left < -1 || el.scrollWidth > el.clientWidth + 1;
        }).map((el) => `${el.tagName}.${el.className}`.slice(0, 80))
      : [];
    const h = empty?.querySelector('h2');
    const reveal = empty?.querySelector('[data-empty-reveal]');
    return {
      dir: document.documentElement.getAttribute('dir'),
      lang: document.documentElement.getAttribute('lang'),
      emptyCase: empty?.getAttribute('data-empty-case') ?? null,
      emptyHeading: txt(h),
      emptyText: txt(empty)?.slice(0, 500) ?? null,
      revealLabel: txt(reveal),
      revealRect: reveal ? (() => { const r = reveal.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), right: Math.round(r.right) }; })() : null,
      chips,
      cardOverflow,
      cards: document.querySelectorAll('article.result-card').length,
      docScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      meta: txt(document.querySelector('.rc-results-meta')),
      coverage: txt(document.querySelector('.coverage-line')),
      hint: txt(document.querySelector('.rc-results-head p')),
    };
  });
  await page.screenshot({ path: `scratch/reea1114-${locale}-${width}.png`, fullPage: false });
  console.log(`\n=== ${locale} ${width} ===`);
  console.log(JSON.stringify({ ...info, errs }, null, 1));
  if (info.emptyCase === 'b') {
    await page.locator('[data-empty-reveal]').first().click();
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => ({
      cards: document.querySelectorAll('article.result-card').length,
      empty: !!document.querySelector('[data-empty-state="true"]'),
      url: window.location.search,
      docScrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    console.log('after reveal:', JSON.stringify(after));
    await page.screenshot({ path: `scratch/reea1114-${locale}-${width}-revealed.png`, fullPage: false });
  }
  await browser.close();
}

for (const locale of ['en', 'ar']) for (const width of [375, 1280]) await run(locale, width);
