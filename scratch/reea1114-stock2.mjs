import pw from 'playwright-core';
import chrome from '@sparticuz/chromium';
const BASE = 'http://localhost:3000';
const Q = 'asus dual geforce rtx 5060 oc edition advanced graphic card';
for (const width of [375, 1280]) {
  const browser = await pw.chromium.launch({ executablePath: await chrome.executablePath(), args: chrome.args });
  const ctx = await browser.newContext({ viewport: { width, height: 1100 }, locale: 'en-KW', extraHTTPHeaders: { 'Accept-Language': 'en-KW,en;q=0.9' } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/results?q=${encodeURIComponent(Q)}`, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('[data-empty-state="true"]'), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(500);
  const chipInfo = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.rc-filter-bar button')).find((x) => x.textContent.includes('In stock'));
    const r = b.getBoundingClientRect();
    return { text: b.textContent, clipped: b.scrollWidth > b.clientWidth + 1, rect: { x: Math.round(r.x), w: Math.round(r.width), right: Math.round(r.right) }, scroll: document.documentElement.scrollWidth };
  });
  console.log(width, 'chip', JSON.stringify(chipInfo));
  await page.screenshot({ path: `scratch/reea1114-stock2-${width}.png` });
  await page.locator('[data-empty-reveal]').first().click();
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => ({
    cards: document.querySelectorAll('article.result-card').length,
    oos: document.querySelectorAll('article.result-card.is-oos').length,
    empty: !!document.querySelector('[data-empty-state="true"]'),
    url: window.location.search,
    scroll: document.documentElement.scrollWidth,
    chip: Array.from(document.querySelectorAll('.rc-filter-bar button')).find((x) => x.textContent.includes('In stock'))?.textContent,
  }));
  console.log(width, 'after', JSON.stringify(after));
  await page.screenshot({ path: `scratch/reea1114-stock2-${width}-revealed.png` });
  await browser.close();
}
