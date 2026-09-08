import pw from 'playwright-core';
import chrome from '@sparticuz/chromium';
const browser = await pw.chromium.launch({ executablePath: await chrome.executablePath(), args: chrome.args });
const page = await browser.newPage();
const reqs = [];
page.on('request', (r) => reqs.push(r.url()));
await page.goto('https://reemco.vercel.app/results?q=jbl%20boombox%203', { waitUntil: 'load', timeout: 30000 });
await page.waitForTimeout(3000); // let staged flushes settle
const loadReqs = reqs.length;
const stampBefore = await page.evaluate(() => document.body.innerHTML.match(/scrapedAt\\":\\"([^\\"]*)/)?.[1]);
await page.click('button:has-text("Saudi Arabia (SAR)")');
await page.waitForTimeout(500);
const afterPill = reqs.length;
await page.click('button[role="checkbox"]');
await page.waitForTimeout(500);
const afterToggle = reqs.length;
await page.click('button:has-text("Refresh")');
await page.waitForTimeout(6000);
const afterRefresh = reqs.length;
const stampAfter = await page.evaluate(() => document.body.innerHTML.match(/scrapedAt\\":\\"([^\\"]*)/)?.[1]);
console.log(JSON.stringify({
  loadReqs, pillAdded: afterPill - loadReqs, toggleAdded: afterToggle - afterPill, refreshAdded: afterRefresh - afterToggle,
  urlEcho: await page.evaluate(() => window.location.search), stampBefore, stampAfter, stampMoved: stampBefore !== stampAfter,
}, null, 1));
await browser.close();
