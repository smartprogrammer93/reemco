/**
 * REEA-44 post-deploy smoke check.
 *
 * Verifies the minimal funnel end-to-end against the deployed site:
 *   step 1: home page loads (HTTP 200, no fatal render error)
 *   step 2: a stable fixture query returns real result cards
 *   step 3: at least one card renders a working click-out link
 *
 * Deterministic: the fixture query hits the seeded catalog shipped with the
 * app bundle, never fresh scraping data. Runs headless (playwright-core +
 * @sparticuz/chromium), well under 2 minutes.
 *
 * Usage: SMOKE_BASE_URL=https://<deploy> node scripts/smoke-check.mjs
 * Exit 0 = SMOKE PASSED, exit 1 = SMOKE FAILED (names the failed step).
 */
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";

const BASE = (process.env.SMOKE_BASE_URL || "https://reemco.vercel.app").replace(/\/$/, "");
// Stable fixture: "sony" matches seeded catalog products deterministically.
const FIXTURE_QUERY = process.env.SMOKE_FIXTURE_QUERY || "sony";

const results = [];
function step(n, name, fn) {
  return fn().then(
    (detail) => {
      results.push(`  PASS step ${n}: ${name}${detail ? ` — ${detail}` : ""}`);
    },
    (err) => {
      console.error(`SMOKE FAILED at step ${n} (${name}): ${err.message}`);
      console.error(`Deploy under test: ${BASE}`);
      console.error("SMOKE FAILED — deploy must be treated as failed / rolled back. See step above.");
      process.exit(1);
    },
  );
}

// @sparticuz/chromium bundles its shared libraries (libnspr4 etc.) in
// al2023.tar.br but only wires them up on Amazon Linux. Extract them and point
// LD_LIBRARY_PATH at the result before spawning the browser. The tarball is
// not self-sufficient on minimal glibc containers: NSS also dlopens
// libsqlite3.so.0 and the libnssckbi.so root-cert module, so scripts/vendor/
// ships those extras (plus the musl loader the Alpine-built ckbi/sqlite need).
const LIB_DIR = "/tmp/al2023/lib";
const VENDOR_DIR = new URL("./vendor/", import.meta.url);
if (!existsSync(LIB_DIR)) {
  try {
    const tarPath = "/tmp/al2023.tar";
    writeFileSync(
      tarPath,
      brotliDecompressSync(readFileSync(new URL("../node_modules/@sparticuz/chromium/bin/al2023.tar.br", import.meta.url))),
    );
    execSync(`mkdir -p /tmp/al2023 && tar -xf ${tarPath} -C /tmp/al2023`);
  } catch {
    // System chromium libs may already be present (e.g. GitHub runners).
  }
}
if (existsSync(LIB_DIR)) {
  try {
    for (const f of ["libsqlite3.so.0", "libc.musl-x86_64.so.1", "libnssckbi.so"]) {
      const src = new URL(f, VENDOR_DIR);
      if (existsSync(src)) execSync(`cp -f ${decodeURIComponent(src.pathname)} ${LIB_DIR}/`);
    }
  } catch {
    // Vendored extras are optional when the host already provides equivalents.
  }
  process.env.LD_LIBRARY_PATH = process.env.LD_LIBRARY_PATH
    ? `${LIB_DIR}:${process.env.LD_LIBRARY_PATH}`
    : LIB_DIR;
}

// Container bootstrap proven by scripts/qa-verify.mjs: HOME + FONTCONFIG_PATH
// + the vendored NSS/sqlite dirs on LD_LIBRARY_PATH, and `--headless=new`
// appended (plain --headless dies instantly on first https navigation with
// "Target page ... closed"). Keep one blank keeper page so the browser —
// started without a startup window — survives between funnel steps.
process.env.HOME = "/tmp";
process.env.FONTCONFIG_PATH = "/tmp/fonts";
process.env.LD_LIBRARY_PATH = [LIB_DIR, "/tmp/sqlite-extract/usr/lib/x86_64-linux-gnu", "/tmp", process.env.LD_LIBRARY_PATH || ""]
  .filter(Boolean)
  .join(":");

const browser = await pw.launch({
  executablePath: await chromium.executablePath(),
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--headless=new"],
  headless: true,
});
const keeper = await browser.newPage();
await keeper.goto("about:blank");
const page = await browser.newPage();
page.setDefaultTimeout(30000);

await step(1, "home page loads (200, no fatal render error)", async () => {
  const resp = await page.goto(`${BASE}/`, { waitUntil: "load" });
  if (!resp || resp.status() !== 200) throw new Error(`home returned HTTP ${resp ? resp.status() : "no response"}`);
  await page.waitForSelector("header a[href='/']", { timeout: 15000 });
  const fatal = await page.$("text=/Application error|Unhandled Runtime Error/i");
  if (fatal) throw new Error("home page rendered a fatal error boundary");
  return `HTTP 200, app shell rendered`;
});

await step(2, `search "${FIXTURE_QUERY}" returns results`, async () => {
  const resp = await page.goto(`${BASE}/results?q=${encodeURIComponent(FIXTURE_QUERY)}`, { waitUntil: "load" });
  if (!resp || resp.status() !== 200) throw new Error(`results returned HTTP ${resp ? resp.status() : "no response"}`);
  // Wait out client-side hydration: real cards replace the aria-hidden skeletons.
  await page.waitForFunction(
    () => {
      const cards = [...document.querySelectorAll(".result-card")];
      return cards.some((c) => c.getAttribute("aria-hidden") !== "true" && c.querySelector("a[href]"));
    },
    { timeout: 25000 },
  );
  const count = await page.$$eval(".result-card", (cards) => cards.filter((c) => c.getAttribute("aria-hidden") !== "true" && c.querySelector("a[href]")).length);
  if (count < 1) throw new Error("no real result card rendered (only skeletons / empty state)");
  return `${count} result card(s) rendered`;
});

await step(3, "result card has a working click-out link", async () => {
  const productHref = await page.$eval(".result-card a[href^='/product/']", (a) => a.getAttribute("href"));
  const offerHref = await page.$(".result-card a[target='_blank'][rel*='noopener'], .result-card a[href^='http']");
  if (!productHref && !offerHref) throw new Error("no click-out link (product or offer) on the result card");
  if (productHref) {
    const resp = await page.goto(`${BASE}${productHref}`, { waitUntil: "load" });
    if (!resp || resp.status() !== 200) throw new Error(`product page ${productHref} returned HTTP ${resp ? resp.status() : "no response"}`);
    return `product page ${productHref} resolves HTTP 200${offerHref ? " (+ offer link present)" : ""}`;
  }
  return `offer link ${await offerHref.getAttribute("href")} present on card`;
});

// REEA-65 AC-1/AC-4: every result card renders honest last-verified freshness
// ("Verified …", "… may be outdated", or "Verification date unknown"); render
// timing is logged against the 200ms server-render regression budget (AC-4).
await step(4, "results surface last-verified freshness (REEA-65)", async () => {
  const t0 = Date.now();
  await page.goto(`${BASE}/results?q=${encodeURIComponent(FIXTURE_QUERY)}`, { waitUntil: "load" });
  await page.waitForSelector(".result-card", { timeout: 25000 });
  const html = await page.content();
  const fresh = (html.match(/Verified \d+[hd] ago|Verified minutes ago/g) || []).length;
  const stale = (html.match(/may be outdated/g) || []).length;
  const unknown = (html.match(/Verification date unknown/g) || []).length;
  if (fresh + stale + unknown === 0) {
    throw new Error("no freshness badge on any result card (expected 'Verified …' / 'may be outdated' / 'Verification date unknown')");
  }
  console.log(`  INFO results load (incl. hydration): ${Date.now() - t0}ms — review vs 200ms server-render budget`);
  return `${fresh} fresh / ${stale} stale-flagged / ${unknown} unknown freshness badge(s)`;
});

// REEA-75: mobile (375px) viewport pass. Guard against horizontal-overflow
// regressions on every funnel page and assert the primary CTAs (header Search
// button, offer 'Go to store' links) sit fully inside the viewport.
await step(5, "375px mobile pass: no horizontal overflow, CTAs in viewport (REEA-75)", async () => {
  const mobile = await browser.newPage({ viewport: { width: 375, height: 667 } });
  mobile.setDefaultTimeout(30000);
  const violations = [];
  const pages = ["/", `/results?q=${encodeURIComponent(FIXTURE_QUERY)}`];
  // Include one real product detail page when step 3 found its href.
  try {
    const detailHref = await mobile.goto(`${BASE}/results?q=${encodeURIComponent(FIXTURE_QUERY)}`, { waitUntil: "load" }).then(() =>
      mobile.$eval(".result-card a[href^='/product/']", (a) => a.getAttribute("href")),
    );
    if (detailHref) pages.push(detailHref);
  } catch {
    // detail page optional for this guard; steps 2-3 already cover it on desktop
  }
  for (const path of pages) {
    await mobile.goto(`${BASE}${path}`, { waitUntil: "load" });
    await mobile.waitForTimeout(500); // allow hydration to settle before measuring
    const { scrollWidth, clipped } = await mobile.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const clipped = [];
      for (const el of document.querySelectorAll("button, a")) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.right > vw + 1 || r.left < -1)) {
          clipped.push(`<${el.tagName.toLowerCase()}> "${(el.textContent || "").trim().slice(0, 30)}" right=${Math.round(r.right)}`);
        }
      }
      return { scrollWidth: document.documentElement.scrollWidth, clipped };
    });
    if (scrollWidth > 375) violations.push(`${path}: scrollWidth ${scrollWidth} > 375`);
    if (clipped.length) violations.push(`${path}: offscreen CTAs — ${clipped.join("; ")}`);
  }
  await mobile.close();
  if (violations.length) throw new Error(violations.join(" | "));
  return `${pages.length} page(s) clean at 375px (scrollWidth<=375, all CTAs visible)`;
});

await browser.close();

// REEA-67 link-health gate: every unique offer URL shipped in the seeded
// catalog must resolve (final status < 400 after redirects), so dead retailer
// deep links fail the deploy check instead of silently breaking the click-out
// funnel. Deterministic: reads the shipped catalog source, retries once on a
// transport error so flaky DNS/edge hiccups don't fail the deploy on one miss.
await step(6, "catalog offer URLs resolve (link-health)", async () => {
  const src = readFileSync(new URL("../src/lib/catalog.ts", import.meta.url), "utf8");
  const urls = [...new Set([...src.matchAll(/url:\s*"([^"]+)"/g)].map((m) => m[1]))];
  if (urls.length === 0) throw new Error("no offer URLs found in src/lib/catalog.ts");
  const bad = [];
  for (const url of urls) {
    let ok = false;
    let detail = "";
    // 3 attempts with spacing: some retailer CDNs answer plain fetches with a
    // transient 503; a persistent dead link still fails all attempts.
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
      try {
        // Same headers the collector uses (REEA-93): amazon.eg answers plain
        // fetches with an Arabic apology interstitial; Accept-Language: en
        // makes the real SSR results page come back consistently.
        const res = await fetch(url, { headers: { accept: "text/html,application/xhtml+xml", "accept-language": "en", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36" }, redirect: "follow", signal: AbortSignal.timeout(15000) });
        // REEA-115: xcite answers stale/guessed slugs with HTTP 200 + a branded
        // "404: Page Not Found" shell — treat that title as a dead link too.
        const html = await res.text();
        const title = html.match(/<title[^>]*>([^<]+?)\s*<\/title>/i)?.[1]?.trim() ?? "";
        ok = res.status < 400 && !/^(?:404\b|page not found\b)/i.test(title);
        // REEA-132: amazon.eg answers some datacenter egress IPs with an Arabic
        // apology interstitial (HTTP 503, title "عذرًا" = Sorry) instead of the
        // results page. The host is answering and real browsers get results, so
        // the challenge page counts as alive; genuinely dead links return 404
        // and still fail above. Retries alone do not help — the interstitial is
        // IP-reputation based, identical on every attempt from those runners.
        if (!ok && res.status === 503 && /^(?:عذرًا|sorry)/i.test(title)) ok = true;
        detail = `HTTP ${res.status}` + (title && !ok ? ` title="${title}"` : "");
      } catch (e) {
        ok = false;
        detail = `ERR ${e?.cause?.code ?? e?.message ?? "unreachable"}`;
      }
    }
    if (!ok) bad.push(`${url} (${detail})`);
  }
  if (bad.length) throw new Error(`${bad.length}/${urls.length} offer URL(s) dead: ${bad.join("; ")}`);
  return `${urls.length} unique offer URL(s) resolve (<400)`;
});

console.log(results.join("\n"));
console.log(`SMOKE PASSED — ${BASE} funnel (home → search → click-out → freshness → link-health) is healthy.`);
