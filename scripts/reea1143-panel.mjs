/**
 * REEA-1143 live panel probe.
 *
 * Reads the served results page HTML (RSC flight payload embedded in the
 * document) and reports, per query/locale:
 *   - the ordered product titles the page will render (top 3 + card count)
 *   - the aggregate coverage line rendered above the results
 *   - per-card retailer counts (multi-retailer depth)
 *
 * Usage:
 *   BASE_URL=https://ns539626.ip-144-217-72.net node scripts/reea1143-panel.mjs
 *   BASE_URL=... QUERIES="air fryer,ps5" LOCALES=en,ar node scripts/reea1143-panel.mjs
 *   BROWSER=1 BASE_URL=... node scripts/reea1143-panel.mjs   # final DOM render
 *
 * Two modes, and they are NOT equivalent:
 *   - default: reads the served document (first paint). Fast, but the results
 *     client merges the rest of the run via /api/results-followup afterwards,
 *     so a first-paint card list can hold only the fastest lanes.
 *   - BROWSER=1: renders the page headless, waits for the merged list to
 *     settle, and reads the card order a shopper actually sees. Use this for
 *     AC1/AC2 ordering; use the default for the AC3 coverage line and lane
 *     counts, which are rendered server-side.
 *
 * Exit code is 0 even when a card looks wrong; the caller decides. The probe
 * prints a compact table so a QA run can paste it into the ticket.
 */

const BASE = (process.env.BASE_URL || "https://ns539626.ip-144-217-72.net").replace(/\/$/, "");
const QUERIES = (process.env.QUERIES || "air fryer,ps5,laptop,headphones,fold 7,iPhone 17 Pro,panadol")
  .split(",")
  .map((q) => q.trim())
  .filter(Boolean);
const LOCALES = (process.env.LOCALES || "en,ar").split(",").map((l) => l.trim()).filter(Boolean);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 120000);

// Collect every self.__next_f.push([1,"..."]) chunk, in document order, and
// decode the JS string literal. Flight rows are chunked but concatenating the
// decoded payloads in order reconstructs the serialized tree.
function decodeFlight(html) {
  const chunks = [];
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      chunks.push(JSON.parse(m[1]));
    } catch {
      // A chunk that is not a standalone string literal is not ours to decode.
    }
  }
  return chunks.join("");
}

// Extract every balanced JSON array that follows `"<key>":[` and return the
// largest one. The RSC stream serializes an empty skeleton first and fills it
// in later rows, so "first match" is the wrong heuristic.
function extractArray(text, key) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(`"${key}":[`, from);
    if (at < 0) break;
    let i = text.indexOf("[", at);
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let p = i; p < text.length; p += 1) {
      const ch = text[p];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "[") depth += 1;
      else if (ch === "]") {
        depth -= 1;
        if (depth === 0) {
          end = p;
          break;
        }
      }
    }
    if (end < 0) break;
    try {
      out.push(JSON.parse(text.slice(i, end + 1)));
    } catch {
      // skip an unparsable fragment
    }
    from = end + 1;
  }
  if (!out.length) return null;
  return out.reduce((best, cur) => (cur.length > best.length ? cur : best), out[0]);
}

// Same "largest occurrence" rule for `"<key>":{ ... }` objects.
function extractObject(text, key) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(`"${key}":{`, from);
    if (at < 0) break;
    let i = text.indexOf("{", at);
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let p = i; p < text.length; p += 1) {
      const ch = text[p];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = p;
          break;
        }
      }
    }
    if (end < 0) break;
    try {
      out.push(JSON.parse(text.slice(i, end + 1)));
    } catch {
      // skip
    }
    from = end + 1;
  }
  if (!out.length) return null;
  return out.reduce((best, cur) => {
    const score = (o) => (o.queried || []).length;
    return score(cur) > score(best) ? cur : best;
  }, out[0]);
}

function decodeEntities(s) {
  return s
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function visibleCoverage(html) {
  // The rendered aggregate line is plain markup, not flight data. Strip tags
  // around the sentence and collapse whitespace.
  const text = decodeEntities(html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " "));
  const en = text.match(/\d+\s+stores checked[^.]{0,160}\./);
  const ar = text.match(/تم فحص\s+\d+\s+متجر[^.]{0,200}\./);
  return { en: en ? en[0].replace(/\s+/g, " ").trim() : null, ar: ar ? ar[0].replace(/\s+/g, " ").trim() : null };
}

async function probe(query, locale) {
  const url = `${BASE}/results?q=${encodeURIComponent(query)}`;
  const started = Date.now();
  const res = await fetch(url, {
    headers: { Cookie: `rc_locale=${locale}`, "User-Agent": "reea1143-panel/1.0" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const html = await res.text();
  const flight = decodeFlight(html);
  const products = extractArray(flight, "products") || [];
  const responders = extractObject(flight, "responders");
  return {
    query,
    locale,
    http: res.status,
    ms: Date.now() - started,
    cards: products.map((p) => ({
      title: p.title,
      merchants: [...new Set((p.offers || []).map((o) => o.merchant))],
      markets: [...new Set((p.offers || []).map((o) => o.market).filter(Boolean))],
    })),
    coverage: visibleCoverage(html),
    responders,
  };
}

/**
 * Browser mode (BROWSER=1) — the authoritative AC1 read.
 *
 * The document HTML is only the first paint: the results client merges the
 * rest of the run in through /api/results-followup and re-orders. A first-paint
 * card list can therefore show only the fastest lanes (measured: `laptop` EN
 * first paint listed Danube Home trolleys, final render listed HP laptops).
 * This mode waits for the merged list to settle and reads the DOM order.
 */
async function browserPanel() {
  process.env.HOME = "/tmp";
  process.env.FONTCONFIG_PATH = "/tmp/fonts";
  process.env.LD_LIBRARY_PATH = `/tmp/al2023/lib:/tmp/sqlite-extract/usr/lib/x86_64-linux-gnu:/tmp:${process.env.LD_LIBRARY_PATH || ""}`;
  const { chromium } = await import("playwright-core");
  const sparticuz = await import("@sparticuz/chromium");
  const out = [];
  // @sparticuz/chromium runs --single-process; a long-lived browser dies after
  // a handful of pages (measured: "Target page, context or browser has been
  // closed" at newPage). One browser per page is slower but survives the run.
  for (const locale of LOCALES) {
    for (const query of QUERIES) {
      const started = Date.now();
      let browser = null;
      let page = null;
      try {
        browser = await chromium.launch({
          executablePath: await sparticuz.default.executablePath(),
          args: [...sparticuz.default.args, "--headless=new"],
          headless: true,
        });
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        await context.addCookies([{ name: "rc_locale", value: locale, url: BASE }]);
        page = await context.newPage();
        await page.goto(`${BASE}/results?q=${encodeURIComponent(query)}`, {
          waitUntil: "domcontentloaded",
          timeout: TIMEOUT_MS,
        });
        // The coverage line is rendered on every results page, including the
        // empty/failure ones, so it is the reliable ready signal; waiting on a
        // card would hang a genuinely empty page.
        await page.waitForSelector(".coverage-line", { timeout: TIMEOUT_MS });
        // Wait for the follow-up merge to settle: card count stable across
        // several polls, bounded by the follow-up's own ceiling.
        let last = -1;
        let stable = 0;
        for (let i = 0; i < 30; i += 1) {
          const n = await page.locator("article.rc-card").count();
          stable = n === last ? stable + 1 : 0;
          last = n;
          if (stable >= 3) break;
          await page.waitForTimeout(700);
        }
        const cards = await page.evaluate(() =>
          [...document.querySelectorAll("article.rc-card")].map((card) => ({
            title: card.querySelector("h2.rc-card-title")?.textContent?.trim() || null,
            merchants: [
              ...new Set(
                [...card.querySelectorAll(".rc-retailer-name bdi")].map((n) => n.textContent.trim()).filter(Boolean),
              ),
            ],
          })),
        );
        const coverageText = await page
          .locator(".coverage-line")
          .first()
          .textContent()
          .catch(() => null);
        out.push({
          query,
          locale,
          http: 200,
          ms: Date.now() - started,
          cards,
          coverage: {
            en: (coverageText || "").match(/\d+\s+stores checked[^.]{0,160}\./)?.[0]?.trim() || null,
            ar: (coverageText || "").match(/تم فحص\s+\d+\s+متجر[^.]{0,200}\./)?.[0]?.trim() || null,
          },
          rawCoverage: (coverageText || "").replace(/\s+/g, " ").trim() || null,
        });
      } catch (err) {
        out.push({ query, locale, error: String(err && err.message ? err.message : err) });
      } finally {
        if (page) await page.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
      }
    }
  }
  return out;
}

const results = [];
const browserMode = process.env.BROWSER === "1";
if (browserMode) {
  results.push(...(await browserPanel()));
} else {
for (const locale of LOCALES) {
  for (const query of QUERIES) {
    try {
      results.push(await probe(query, locale));
    } catch (err) {
      results.push({ query, locale, error: String(err && err.message ? err.message : err) });
    }
  }
}
}

const stampRes = await fetch(`${BASE}/__commit.txt`, { signal: AbortSignal.timeout(20000) }).catch(() => null);
const stamp = stampRes ? (await stampRes.text()).trim() : null;

console.log(`# REEA-1143 panel — ${BASE} — stamp ${stamp} — ${new Date().toISOString()}`);
for (const r of results) {
  if (r.error) {
    console.log(`\n${r.locale} ${JSON.stringify(r.query)}: ERROR ${r.error}`);
    continue;
  }
  const top = r.cards.slice(0, 3).map((c) => `${c.title} [${c.merchants.join("/")}]`);
  const multi = r.cards.filter((c) => c.merchants.length > 1).length;
  console.log(`\n${r.locale} ${JSON.stringify(r.query)}: http=${r.http} ${r.ms}ms cards=${r.cards.length} multi=${multi}/${r.cards.length}`);
  top.forEach((t, i) => console.log(`  #${i + 1} ${t}`));
  if (r.coverage.en || r.coverage.ar) console.log(`  coverage EN=${JSON.stringify(r.coverage.en)} AR=${JSON.stringify(r.coverage.ar)}`);
  if (r.rawCoverage) console.log(`  coverage rendered=${JSON.stringify(r.rawCoverage)}`);
  if (r.responders) {
    const q = (r.responders.queried || []).length;
    console.log(
      `  lanes queried=${q} answered=${(r.responders.answered || []).length} empty=${(r.responders.answeredEmpty || []).length} failed=${(r.responders.noResponse || []).length}`,
    );
  }
}

if (process.env.JSON_OUT) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.JSON_OUT, JSON.stringify({ base: BASE, stamp, at: new Date().toISOString(), results }, null, 2));
  console.log(`\nwrote ${process.env.JSON_OUT}`);
}
