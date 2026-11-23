import pw from 'playwright-core';
import chrome from '@sparticuz/chromium';
const BASE = 'http://localhost:3000';
const Q = 'asus dual geforce rtx 5060 oc edition advanced graphic card';
for (const width of [375, 1280]) {
  const browser = await pw.chromium.launch({ executablePath: await chrome.executablePath(), args: chrome.args });
  const ctx = await browser.newContext({ viewport: { width, height: 1100 }, locale: 'ar-KW', extraHTTPHeaders: { 'Accept-Language': 'ar-KW,ar;q=0.9' } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/results?q=${encodeURIComponent(Q)}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('[data-empty-state="true"]'), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(500);
  const info = await page.evaluate(() => {
    const t = (el) => el ? el.textContent.replace(/\s+/g,' ').trim() : null;
    const empty = document.querySelector('[data-empty-state="true"]');
    const b = Array.from(document.querySelectorAll('.rc-filter-bar button')).find((x) => x.textContent.includes('متوفر'));
    const r = b.getBoundingClientRect();
    return {
      dir: document.documentElement.getAttribute('dir'),
      heading: t(empty?.querySelector('h2')),
      reveal: t(empty?.querySelector('[data-empty-reveal]')),
      chip: t(b),
      chipClipped: b.scrollWidth > b.clientWidth + 1,
      chipRect: { x: Math.round(r.x), w: Math.round(r.width), right: Math.round(r.right) },
      scroll: document.documentElement.scrollWidth,
    };
  });
  console.log(width, JSON.stringify(info));
  await page.screenshot({ path: `scratch/reea1114-ar-stock-${width}.png` });
  await page.locator('[data-empty-reveal]').first().click();
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => ({ cards: document.querySelectorAll('article.result-card').length, url: window.location.search, scroll: document.documentElement.scrollWidth }));
  console.log(width, 'after', JSON.stringify(after));
  await browser.close();
}
// genuine no-match
{
  const browser = await pw.chromium.launch({ executablePath: await chrome.executablePath(), args: chrome.args });
  const ctx = await browser.newContext({ viewport: { width: 375, height: 900 }, locale: 'en-KW', extraHTTPHeaders: { 'Accept-Language': 'en-KW,en;q=0.9' } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/results?q=zzzzqqq`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('[data-empty-state="true"]'), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(500);
  const o = await page.evaluate(() => {
    const t = (el) => el ? el.textContent.replace(/\s+/g,' ').trim() : null;
    const empty = document.querySelector('[data-empty-state="true"]');
    return { case: empty?.getAttribute('data-empty-case'), text: t(empty), hint: t(document.querySelector('.rc-results-head p')), scroll: document.documentElement.scrollWidth };
  });
  console.log('zzzzqqq', JSON.stringify(o));
  await page.screenshot({ path: 'scratch/reea1114-zzzzqqq-375.png' });
  await browser.close();
}
