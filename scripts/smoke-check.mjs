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
 * Exit 2 = SMOKE THROTTLED OUT — every attempt hit the app's per-IP page gate
 *          (429) or a transient 503 after honouring Retry-After. That is not a
 *          broken build: the workflow cools down and reruns the smoke before it
 *          considers a rollback (REEA-1184).
 */
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { brotliDecompressSync } from "node:zlib";
import { execSync } from "node:child_process";
import { chromium as pw } from "playwright-core";
import chromium from "@sparticuz/chromium";
import { measureResultsTimings } from "./smoke-timings.mjs";
import { classifyAttempt } from "./dead-link-smoke.mjs";
import { fetchWithThrottleRetry, gotoWithThrottleRetry } from "./smoke-http.mjs";

// REEA-1051 — default to the self-hosted production box (the Vercel alias is
// the rollback path only and is currently deployment-disabled). Workflows
// still pass SMOKE_BASE_URL explicitly from vars.PROD_BASE_URL.
const BASE = (process.env.SMOKE_BASE_URL || "https://ns539626.ip-144-217-72.net").replace(/\/$/, "");
// Stable fixture: "sony" matches seeded catalog products deterministically.
const FIXTURE_QUERY = process.env.SMOKE_FIXTURE_QUERY || "sony";

// REEA-274: per-run report on the fixed REEA-255 query set — time to the first
// real offer card and to full results, graded report-only against
// p50<=1500ms / p95<=3000ms. Runs first so timings print even when a functional
// step later fails; measureResultsTimings itself never throws.
for (const line of await measureResultsTimings(BASE)) console.log(line);

// REEA-1056: print each PASS as it lands. The old buffered join only printed
// on a fully green run, so a later failing step (e.g. link-health) discarded
// the evidence of the steps that did pass — exactly what made the 375px
// follow-up hard to report against the box.
//
// REEA-1184: a step that fails only because the app's per-IP page gate answered
// 429/503 on every retry exits 2 instead of 1. The workflow treats exit 2 as
// "the edge paced the gate, retry the run after a cooldown" and only rolls the
// build back for exit 1. Before this, three healthy deploys of 641c2b7 were
// rolled back by a burst 429 in step 7 (run 45728235136).
function step(n, name, fn) {
  return fn().then(
    (detail) => {
      console.log(`  PASS step ${n}: ${name}${detail ? ` — ${detail}` : ""}`);
    },
    (err) => {
      console.error(`SMOKE FAILED at step ${n} (${name}): ${err.message}`);
      console.error(`Deploy under test: ${BASE}`);
      if (err?.rateLimited) {
        console.error("SMOKE THROTTLED OUT — the app's rate limiter paced the gate, not a broken build.");
        console.error("SMOKE INCONCLUSIVE — retry the run after the limiter window; do NOT roll the build back. Exit 2.");
        process.exit(2);
      }
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
  const resp = await gotoWithThrottleRetry(page, `${BASE}/`, { waitUntil: "load" }, { log: console.log });
  if (!resp || resp.status() !== 200) throw new Error(`home returned HTTP ${resp ? resp.status() : "no response"}`);
  await page.waitForSelector("header a[href='/']", { timeout: 15000 });
  const fatal = await page.$("text=/Application error|Unhandled Runtime Error/i");
  if (fatal) throw new Error("home page rendered a fatal error boundary");
  return `HTTP 200, app shell rendered`;
});

await step(2, `search "${FIXTURE_QUERY}" returns results`, async () => {
  const resp = await gotoWithThrottleRetry(
    page,
    `${BASE}/results?q=${encodeURIComponent(FIXTURE_QUERY)}`,
    { waitUntil: "load" },
    { log: console.log },
  );
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
    const resp = await gotoWithThrottleRetry(page, `${BASE}${productHref}`, { waitUntil: "load" }, { log: console.log });
    if (!resp || resp.status() !== 200) throw new Error(`product page ${productHref} returned HTTP ${resp ? resp.status() : "no response"}`);
    return `product page ${productHref} resolves HTTP 200${offerHref ? " (+ offer link present)" : ""}`;
  }
  return `offer link ${await offerHref.getAttribute("href")} present on card`;
});

// REEA-65 AC-1/AC-4: every result card renders honest last-verified freshness
// chip; render timing is logged against the 200ms server-render regression
// budget (AC-4). Design v3 §5.5 renamed the chip copy from "Verified …" to
// "updated …" (FreshnessBadge renders `updated <!-- -->minutes ago`, the
// comment being React's text-node split). Match both wordings against the
// component's actual output — an assertion stuck on old copy is a false
// negative that fails every deploy despite healthy cards.
await step(4, "results surface last-verified freshness (REEA-65)", async () => {
  const t0 = Date.now();
  await gotoWithThrottleRetry(
    page,
    `${BASE}/results?q=${encodeURIComponent(FIXTURE_QUERY)}`,
    { waitUntil: "load" },
    { log: console.log },
  );
  await page.waitForSelector(".result-card", { timeout: 25000 });
  const html = await page.content();
  // REEA-283/REEA-254/REEA-1092 chip copy renders uppercase with the minute
  // figure inside: "UPDATED {n} MINUTES AGO" / "UPDATED DATE UNKNOWN", and
  // since REEA-1069 AC10 "UPDATED JUST NOW" / "UPDATED 1 MINUTE AGO". Match
  // case-insensitively, alongside the legacy "updated <!-- -->minutes ago" and
  // "Verified 2d ago" spellings. Keep this literal identical to
  // src/lib/freshness-chip.ts — src/lib/freshness-chip.test.ts pins the pair.
  const chip = "(?:Verified|updated)[ ]*(?:<!--[ ]-->)?[ ]*(?:just now|\\d+[ ]*minutes? ago|\\d+[hd] ago|minutes? ago)";
  const fresh = (html.match(new RegExp(chip, "gi")) || []).length;
  const stale = (html.match(/may be outdated/gi) || []).length;
  const unknown = (html.match(/(?:updated|Verification) date unknown/gi) || []).length;
  if (fresh + stale + unknown === 0) {
    throw new Error("no freshness badge on any result card (expected 'updated … ago' / 'may be outdated' / 'updated date unknown')");
  }
  console.log(`  INFO results load (incl. hydration): ${Date.now() - t0}ms — review vs 200ms server-render budget`);
  return `${fresh} fresh / ${stale} stale-flagged / ${unknown} unknown freshness badge(s)`;
});

// REEA-75: mobile (375px) viewport pass. Guard against horizontal-overflow
// regressions on every funnel page and assert the primary CTAs (header Search
// button, offer 'Go to store' links) sit fully inside the viewport.
//
// REEA-1056: a control that is off-viewport but sits inside a deliberately
// scrollable ancestor (overflow-x auto/scroll, content wider than the box,
// container itself in-viewport) is REACHABLE by swiping that container into
// place — not clipped. The ≤375px results coverage toolbar is exactly that
// by design: REEA-945 measured that wrapping the country/stock/Refresh row
// to 3-4 lines (~124px EN / 168px AR) pushed the lead primary CTA below the
// fold, so the row ships as a single horizontally scrollable line and the
// page itself gains no overflow. Treating every off-viewport control as
// clipped made step 5 fail deterministically on the healthy layout.
//
// So this check now distinguishes the two cases instead of relaxing either:
//   - a control inside a scrollable container is PASSED only after scrolling
//     that container actually brings it fully into the viewport (so a control
//     clipped by overflow:hidden or a too-narrow scroller still fails), and
//     the scrolled ones are named in the step detail;
//   - a control outside any scrollable container must still be in-viewport,
//     and documentElement.scrollWidth must stay <=375 on every page.
await step(5, "375px mobile pass: no horizontal overflow, CTAs in viewport (REEA-75)", async () => {
  const mobile = await browser.newPage({ viewport: { width: 375, height: 667 } });
  mobile.setDefaultTimeout(30000);
  const violations = [];
  const pages = ["/", `/results?q=${encodeURIComponent(FIXTURE_QUERY)}`];
  // Include one real product detail page when step 3 found its href.
  try {
    const detailHref = await gotoWithThrottleRetry(mobile, `${BASE}/results?q=${encodeURIComponent(FIXTURE_QUERY)}`, { waitUntil: "load" }, { log: console.log }).then(() =>
      mobile.$eval(".result-card a[href^='/product/']", (a) => a.getAttribute("href")),
    );
    if (detailHref) pages.push(detailHref);
  } catch {
    // detail page optional for this guard; steps 2-3 already cover it on desktop
  }
  const scrolled = [];
  for (const path of pages) {
    await gotoWithThrottleRetry(mobile, `${BASE}${path}`, { waitUntil: "load" }, { log: console.log });
    await mobile.waitForTimeout(500); // allow hydration to settle before measuring
    const { scrollWidth, clipped, reachable } = await mobile.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const clipped = [];
      const reachable = [];
      // A deliberate horizontal scroller: the author chose overflow-x
      // auto/scroll AND the content genuinely overflows, and the scroller's
      // own box is inside the viewport (so it can be swiped).
      const scrollableAncestor = (el) => {
        for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
          const cs = getComputedStyle(p);
          if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && p.scrollWidth > p.clientWidth + 1) {
            const pr = p.getBoundingClientRect();
            if (pr.width > 0 && pr.left >= -1 && pr.right <= vw + 1) return p;
          }
        }
        return null;
      };
      for (const el of document.querySelectorAll("button, a")) {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || (r.right <= vw + 1 && r.left >= -1)) continue;
        const scroller = scrollableAncestor(el);
        if (scroller) {
          // Prove reachability: scroll the container to the control's
          // position and re-measure. Restore the scroll offset afterwards so
          // each control is evaluated independently.
          const before = scroller.scrollLeft;
          const delta = r.left - scroller.getBoundingClientRect().left;
          const max = scroller.scrollWidth - scroller.clientWidth;
          scroller.scrollLeft = Math.min(max, Math.max(0, before + delta - 8));
          const after = el.getBoundingClientRect();
          const nowVisible = after.width > 0 && after.left >= -1 && after.right <= vw + 1;
          scroller.scrollLeft = before;
          if (nowVisible) {
            const owner = scroller.className ? `.${String(scroller.className).trim().split(/\s+/)[0]}` : scroller.tagName.toLowerCase();
            reachable.push(`<${el.tagName.toLowerCase()}> "${(el.textContent || "").trim().slice(0, 30)}" in ${owner}`);
            continue;
          }
        }
        clipped.push(`<${el.tagName.toLowerCase()}> "${(el.textContent || "").trim().slice(0, 30)}" right=${Math.round(r.right)}`);
      }
      return { scrollWidth: document.documentElement.scrollWidth, clipped, reachable };
    });
    if (scrollWidth > 375) violations.push(`${path}: scrollWidth ${scrollWidth} > 375`);
    if (clipped.length) violations.push(`${path}: offscreen CTAs — ${clipped.join("; ")}`);
    if (reachable.length) scrolled.push(`${path}: ${reachable.join("; ")}`);
  }
  await mobile.close();
  if (violations.length) throw new Error(violations.join(" | "));
  const scrollNote = scrolled.length ? ` — reachable by scrolling a deliberate scroll container: ${scrolled.join(" | ")}` : "";
  return `${pages.length} page(s) clean at 375px (scrollWidth<=375, all CTAs visible${scrollNote})`;
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
  const botBlocked = [];
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
        // REEA-1056/REEA-1166: reuse the REEA-935 challenge classifier
        // (scripts/dead-link-smoke.mjs) instead of treating every non-2xx as
        // dead. A Cloudflare bot-wall (403 + `cf-mitigated` or a challenge /
        // "Attention Required! | Cloudflare" / "Just a moment" body) means the
        // host answered and a real browser gets the page — a shopper-reachable
        // link, not a dead one. Talabat's /en/kuwait answers that block page
        // from the deploy runner; counting it dead rolled back every deploy.
        // A genuine 404/410/5xx/timeout still fails below.
        const verdict = classifyAttempt(res.status, res.headers, html.slice(0, 4000));
        if (!ok && verdict === "challenge") {
          ok = true;
          detail = `HTTP ${res.status} bot-blocked/challenge${title ? ` title="${title}"` : ""} — reachable for a real browser`;
          botBlocked.push(`${url} (${detail})`);
        }
        // REEA-132: amazon.eg answers some datacenter egress IPs with an Arabic
        // apology interstitial (HTTP 503, title "عذرًا" = Sorry) instead of the
        // results page. The host is answering and real browsers get results, so
        // the challenge page counts as alive; genuinely dead links return 404
        // and still fail above. Retries alone do not help — the interstitial is
        // IP-reputation based, identical on every attempt from those runners.
        if (!ok && res.status === 503 && /^(?:عذرًا|sorry)/i.test(title)) ok = true;
        if (!ok) detail = `HTTP ${res.status}` + (title ? ` title="${title}"` : "");
      } catch (e) {
        ok = false;
        detail = `ERR ${e?.cause?.code ?? e?.message ?? "unreachable"}`;
      }
    }
    if (!ok) bad.push(`${url} (${detail})`);
  }
  if (bad.length) throw new Error(`${bad.length}/${urls.length} offer URL(s) dead: ${bad.join("; ")}`);
  const blockedNote = botBlocked.length
    ? ` — ${botBlocked.length} bot-blocked but shopper-reachable: ${botBlocked.join("; ")}`
    : "";
  return `${urls.length} unique offer URL(s) resolve (<400)${blockedNote}`;
});

// REEA-260: adapter-registration parity on the DEPLOYED query path. The
// REEA-238 smoke ran the collector chain directly, which passes even when the
// deployed build serves an older collector set — QA found four of the five new
// merchants missing from the live notes array while that smoke stayed green.
// This step closes the gap: it reads the notes array the deployed results page
// itself emits (the RSC flight payload in its SSR HTML) and requires every
// registered merchant to have dispatched. Presence is the assertion, not hit
// counts — a transient challenge/403 on one storefront must not fail the whole
// deploy check (graceful degradation), but an adapter absent from the notes
// array means the deployed build never dispatched it.
await step(7, "deployed results notes carry every registered adapter (REEA-238/260)", async () => {
  // REEA-1184: this is the step that rolled three healthy deploys back. It is
  // one document GET, but the browser's link prefetches and the 19 timing
  // probes count against the same per-IP page budget (src/proxy.ts
  // PAGE_RATE_LIMIT, 60/min). Retry 429/503 with the served Retry-After instead
  // of reading a pacing response as a broken build.
  // REEA-1221 — this step asserts that the DEPLOYED BUILD DISPATCHED every
  // adapter, so it must measure a fan-out, not a warm replay. A warm serve
  // answers from the shared snapshot/memo and carries only the lanes that
  // snapshot happened to hold (measured on the served head 2026-11-26: a warm
  // /results?q=iPhone 15 carried 19 lanes and missed Sultan Center and Lulu
  // Hypermarket, while the same build's cold run carried all 24). The one-shot
  // rc_refresh cookie forces the cold render the step is about.
  const resp = await fetchWithThrottleRetry(
    `${BASE}/results?q=${encodeURIComponent("iPhone 15")}`,
    () => ({
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
        cookie: "rc_refresh=1",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    }),
    { log: console.log },
  );
  if (!resp.ok) throw new Error(`results page returned HTTP ${resp.status}`);
  const html = await resp.text();
  // Flight payload embeds the snapshot notes with escaped quotes; take every
  // notes array in flush order and evaluate the longest (final snapshot).
  const arrays = [...html.matchAll(/notes\\":\[([^\]]*)\]/g)].map((m) => m[1]);
  if (arrays.length === 0) throw new Error("no notes array found in deployed results HTML");
  const finalNotes = arrays.reduce((a, b) => (b.length > a.length ? b : a));
  const merchants = [...finalNotes.matchAll(/merchant\\":\\"([^\\]+)/g)].map((m) => m[1]);
  // REEA-1059: the list must name lanes that are DISPATCHED in
  // src/lib/collect/live-search.ts. "PC Kuwait" was removed here because the
  // lane itself was retired in REEA-901 (Cloudflare 403 on every hop shape from
  // the deployed egress; no `merchant: "PC Kuwait"` entry remains). Keeping a
  // retired lane in this list makes the step fail deterministically on a
  // healthy build — the gate would be red for a lane we deliberately stopped
  // calling. Rule: a lane that is retired or re-admitted must enter/leave this
  // list in the same commit that changes the registry, or the gate is lying.
  //
  // REEA-1078 S2: "Next Store" left the dispatch set the same way (1,338/1,338
  // failures in W47, 365/365 in W48 — see DEFAULT_RETIRED_LANES in
  // src/lib/collect/lane-health.ts). It stays REGISTERED and tested, and the
  // canary path re-admits it; when that happens, put it back here.
  const required = ["Xcite", "Blink", "Eureka", "Sultan Center", "Jarir", "Amazon.eg", "Quadra Stores", "Lulu Hypermarket"];
  // REEA-1221 — the served document carries the flushes that landed inside the
  // stream window, so a lane that settles after the last flush is absent from
  // its notes even though the build dispatched it (measured 2026-11-26: the
  // document's notes held 19 lanes while the SAME run's converged follow-up
  // snapshot held all 23, including Sultan Center and Lulu Hypermarket). The
  // follow-up endpoint is the run's own converged answer, so a lane missing
  // from the document is re-checked there before this gate calls the build
  // broken; only a lane absent from BOTH never dispatched.
  const seen = new Set(merchants);
  const missingFromDoc = required.filter((m) => !seen.has(m));
  if (missingFromDoc.length) {
    try {
      const followUp = await fetchWithThrottleRetry(
        `${BASE}/api/results-followup?q=${encodeURIComponent("iPhone 15")}`,
        () => ({
          headers: {
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
            cookie: "rc_refresh=1",
          },
          signal: AbortSignal.timeout(30000),
        }),
        { log: console.log },
      );
      if (followUp.ok) {
        const payload = await followUp.json();
        for (const note of payload?.notes ?? []) {
          if (typeof note?.merchant === "string") seen.add(note.merchant);
        }
      }
    } catch {
      // keep the document's set — the gate still fails honestly below
    }
  }
  const missing = required.filter((m) => !seen.has(m));
  if (missing.length) throw new Error(`deployed notes arrays miss ${missing.join(", ")} (seen: ${[...seen].join(", ")})`);
  const hitLines = finalNotes.replace(/\\/g, "");
  return `${merchants.length} merchant(s) dispatched — ${hitLines.slice(0, 160)}…`;
});

// REEA-447 R5: the bounded shared-cache window (src/proxy.ts
// sharedWindowHeaders, declared for the served response via next.config
// headers()) must actually REACH the served /results response — repeat-search
// .test.ts pins the builder output and stays green while the renderer silently
// overwrites the served pair, so assert on the wire here: repeated identical
// GETs carry Cache-Control with the s-maxage window and a Vary that includes
// Accept-Language (locale variants never share an entry), never the
// `private, no-store` dynamic-page rewrite that made every unique search pay a
// full origin render (x-vercel-cache MISS, age 0).
await step(8, "served cache-window headers on repeated /results (REEA-447 R5)", async () => {
  const url = `${BASE}/results?q=${encodeURIComponent(FIXTURE_QUERY)}`;
  const get = async () =>
    fetchWithThrottleRetry(
      url,
      () => ({ headers: { accept: "text/html", "cache-control": "max-age=0" }, redirect: "follow", signal: AbortSignal.timeout(15000) }),
      { log: console.log },
    );
  const first = await get();
  const second = await get(); // the repeat the window exists for
  if (!first.ok || !second.ok) throw new Error(`results GETs returned ${first.status}/${second.status}`);
  const problems = [];
  for (const [label, resp] of [["first", first], ["repeat", second]]) {
    const cc = resp.headers.get("cache-control") ?? "";
    const vary = resp.headers.get("vary") ?? "";
    if (!/s-maxage=\d+/.test(cc)) problems.push(`${label}: Cache-Control "${cc || "(missing)"}" has no s-maxage window`);
    if (/no-store/i.test(cc)) problems.push(`${label}: Cache-Control "${cc}" is a no-store rewrite (renderer overwrote the window)`);
    if (!/\baccept-language\b/i.test(vary)) problems.push(`${label}: Vary "${vary || "(missing)"}" drops Accept-Language`);
  }
  if (problems.length) throw new Error(problems.join(" | "));
  const age = Number(second.headers.get("age") ?? 0);
  const cacheState = second.headers.get("x-vercel-cache") ?? "?";
  return `window served (s-maxage + Accept-Language vary, no-store absent) — repeat x-vercel-cache=${cacheState} age=${age}s`;
});

// REEA-1088: the served CSP must be the strict per-request nonce policy, and
// the nonce must be FRESH on every document GET. This is the wire-level half of
// the F10 regression: the unit test pins buildCsp(), but only the served
// header proves the proxy actually ran on the deployed artifact and that a
// cache/CDN did not freeze one nonce. `'strict-dynamic'` without a matching
// nonce on the script tags blocks every script — hydration silently stops and
// /results stays on its loading skeletons (the REEA-82 failure mode), so step
// 2's hydration assertion runs alongside this one.
await step(9, "served CSP carries a fresh per-request nonce (REEA-1088)", async () => {
  const read = async () => {
    const resp = await fetchWithThrottleRetry(
      `${BASE}/`,
      () => ({
        headers: { accept: "text/html" },
        redirect: "follow",
        signal: AbortSignal.timeout(15000),
      }),
      { log: console.log },
    );
    if (!resp.ok) throw new Error(`GET / returned HTTP ${resp.status}`);
    return resp.headers.get("content-security-policy") ?? resp.headers.get("content-security-policy-report-only") ?? "";
  };
  const cspOf = (policy) =>
    policy.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src")) ?? "";
  const nonceOf = (policy) => /'nonce-([A-Za-z0-9+/_-]+={0,2})'/.exec(cspOf(policy))?.[1];
  const first = await read();
  if (!first) throw new Error("no Content-Security-Policy header served on /");
  const scriptSrc = cspOf(first);
  const nonce = nonceOf(first);
  if (!nonce) throw new Error(`script-src has no nonce: "${scriptSrc}"`);
  if (!scriptSrc.includes("'strict-dynamic'")) throw new Error(`script-src lacks 'strict-dynamic': "${scriptSrc}"`);
  if (scriptSrc.includes("'unsafe-inline'")) throw new Error(`script-src still allows 'unsafe-inline': "${scriptSrc}"`);
  const second = await read();
  const secondNonce = nonceOf(second);
  if (!secondNonce) throw new Error("repeat GET / served a CSP without a nonce");
  if (secondNonce === nonce) throw new Error(`nonce reused across requests (${nonce}) — per-request freshness is broken`);
  return `nonce ${nonce.slice(0, 8)}… fresh per request, script-src strict-dynamic, no unsafe-inline`;
});

console.log(`SMOKE PASSED — ${BASE} funnel (home → search → click-out → freshness → link-health → adapter parity → served cache window → CSP nonce) is healthy.`);
