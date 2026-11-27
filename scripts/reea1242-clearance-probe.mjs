/**
 * REEA-1242 — Cloudflare WAF clearance probe.
 *
 * Run this ON the production box, inside the app container, so the fetch is
 * made from the production egress the adapters actually use:
 *
 *   ssh -F /tmp/paperclip/ssh/config reemco-prod \
 *     'docker exec -w /app reemco-app-1 node /app/scripts/reea1242-clearance-probe.mjs'
 *
 *   # panel mode: 12 queries against the served head, asserting the three
 *   # Cloudflare-gated lanes answer (offers or explicit no-match) and never
 *   # settle `blocked:` on a challenge.
 *   docker exec -w /app reemco-app-1 \
 *     env PANEL=1 BASE_URL=http://127.0.0.1:3000 node /app/scripts/reea1242-clearance-probe.mjs
 *
 * It fails loudly (exit 1) when a page is a Cloudflare shell, when a lane has
 * no priced cards, or when a gated lane reports `blocked:` in the panel.
 *
 * Exact URLs it uses (the same routes the adapters ask):
 *   LuLu Hypermarket  https://gcc.luluhypermarket.com/en-kw/list/?search_text=laptop
 *   Next Store        https://www.nextstore.com.kw/catalogsearch/result/index/?q=laptop
 *   Ounass            https://kuwait.ounass.com/?q=laptop
 *
 * The launch/identity shape mirrors src/lib/collect/browser-clearance.ts
 * (pinned desktop Chrome identity + client hints + stealth init). It is
 * duplicated here on purpose: the probe must be able to fail loudly without
 * importing the app's TS bundle. The PANEL mode is the authoritative check —
 * it grades the deployed clearance hop itself.
 */

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const HINTS = {
  accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "sec-ch-ua": '"Chromium";v="126", "Google Chrome";v="126", "Not:A-Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
};

const SHELL_BLOCK = /Sorry, you have been blocked|Attention Required!\s*\|\s*Cloudflare|cf-error-details/i;
const SHELL_CHALLENGE = /Just a moment\.\.\.|Enable JavaScript and cookies to continue|cf-browser-verification|cf-challenge-running/i;

/** The three gated hosts, with the card markers their parsers read. */
export const TARGETS = [
  {
    merchant: "Lulu Hypermarket",
    url: "https://gcc.luluhypermarket.com/en-kw/list/?search_text=laptop",
    // app-product-card + a KD price in the same body.
    // app-product-card + a KWD price in the same body (measured: "2.900 KWD").
    priced: (html) => html.includes("app-product-card") && /\d\s?KWD/.test(html),
    marker: "app-product-card",
  },
  {
    merchant: "Next Store",
    url: "https://www.nextstore.com.kw/catalogsearch/result/index/?q=laptop",
    // Magento grid: card link + data-price-amount.
    // HTML grid (card link + data-price-amount) or the reader relay's
    // markdown render, which carries "KD <price>" rows instead of markup.
    priced: (html) =>
      (html.includes("product-item-link") && html.includes("data-price-amount")) || /KD\s?\d/.test(html),
    marker: "product-item-link",
  },
  {
    merchant: "Ounass",
    url: "https://kuwait.ounass.com/?q=laptop",
    // The SSR island the lane's contract reads.
    priced: (html) => html.includes("OnlineStore") && html.includes("<main"),
    marker: "OnlineStore",
  },
];

export function shellOf(html) {
  if (!html) return "block";
  if (SHELL_BLOCK.test(html)) return "block";
  if (SHELL_CHALLENGE.test(html)) return "challenge";
  return "";
}

/** One plain hop with the browser-shaped identity the app's lanes lead with. */
async function plainHop(url) {
  const res = await fetch(url, {
    headers: { ...HINTS, "user-agent": UA },
    signal: AbortSignal.timeout(25_000),
  }).catch((err) => ({ ok: false, status: 0, text: async () => "", error: String(err) }));
  const html = res.text ? await res.text().catch(() => "") : "";
  return { via: "plain", status: res.status ?? 0, html, error: res.error };
}

/** The reader relay the lane falls back to when the origin refuses our egress. */
async function relayHop(url, mode) {
  const headers = {
    "x-respond-with": mode,
    "x-timeout": mode === "markdown" ? "45" : "40",
    accept: mode === "markdown" ? "text/plain" : "text/html",
  };
  if (process.env.JINA_API_KEY) headers.authorization = `Bearer ${process.env.JINA_API_KEY}`;
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers,
    signal: AbortSignal.timeout(45_000),
  }).catch((err) => ({ ok: false, status: 0, text: async () => "", error: String(err) }));
  const html = res.text ? await res.text().catch(() => "") : "";
  return { via: `relay-${mode}`, status: res.status ?? 0, html, error: res.error };
}

/** The durable tier: a real Chromium with the pinned desktop identity. */
async function launchBrowser() {
  const sparticuzMod = await import("@sparticuz/chromium");
  const sparticuz = sparticuzMod.default;
  const libDir = join(tmpdir(), "al2023", "lib");
  if (!existsSync(libDir)) {
    const candidates = [join(process.cwd(), "node_modules", "@sparticuz", "chromium", "bin", "al2023.tar.br")];
    try {
      const entry = createRequire(import.meta.url).resolve("@sparticuz/chromium");
      if (entry.startsWith("/")) candidates.push(join(dirname(entry), "..", "bin", "al2023.tar.br"));
    } catch {
      // bundler-resolved path — the cwd candidate still applies
    }
    const archive = candidates.find((c) => existsSync(c));
    if (archive) await sparticuzMod.inflate(archive);
  }
  if (existsSync(libDir)) sparticuzMod.setupLambdaEnvironment(libDir);
  const executablePath = await sparticuz.executablePath();
  const { chromium } = await import("playwright-core");
  const base = sparticuz.args.filter(
    (a) => a !== "--single-process" && a !== "--no-zygote" && a !== "--in-process-gpu",
  );
  const browser = await chromium.launch({
    executablePath,
    args: [...base, "--disable-gpu", "--disable-blink-features=AutomationControlled", "--window-size=1366,900"],
    headless: true,
    env: process.env,
  });
  const context = await browser.newContext({
    userAgent: UA,
    locale: "en-US",
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: HINTS,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
  });
  return { browser, context };
}

async function browserHop(browser, target) {
  const page = await browser.context.newPage();
  try {
    const res = await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 25_000 });
    const first = await page.content();
    if (shellOf(first) === "block") return { via: "browser", status: res?.status() ?? 0, html: "" };
    await page
      .waitForFunction((sel) => document.querySelector(sel) !== null, target.marker, { timeout: 15_000 })
      .catch(() => undefined);
    return { via: "browser", status: res?.status() ?? 0, html: await page.content() };
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function runHops() {
  const forceBrowser = process.env.FORCE_BROWSER === "1";
  let browser = forceBrowser ? await launchBrowser() : null;
  const failures = [];
  const rows = [];
  for (const target of TARGETS) {
    const attempts = [];
    if (forceBrowser) {
      attempts.push(await browserHop(browser, target).catch((e) => ({ via: "browser", status: 0, html: "", error: String(e) })));
    } else {
      attempts.push(await plainHop(target.url));
      if (shellOf(attempts[0].html)) {
        attempts.push(await browserHop(browser ?? (browser = await launchBrowser()), target).catch((e) => ({ via: "browser", status: 0, html: "", error: String(e) })));
      }
    }
    const last = attempts[attempts.length - 1];
    if (shellOf(last.html)) {
      // The origin (or our egress) refused every local path: the reader relay
      // is the lane's documented last hop, and the markdown render is the one
      // that paints Next Store's grid.
      attempts.push(await relayHop(target.url, target.merchant === "Next Store" ? "markdown" : "html"));
    }
    const answer = attempts.find((a) => !shellOf(a.html) && target.priced(a.html));
    const row = {
      merchant: target.merchant,
      url: target.url,
      ok: Boolean(answer),
      via: answer?.via ?? null,
      status: answer?.status ?? attempts[attempts.length - 1].status,
      bytes: answer?.html.length ?? 0,
      attempts: attempts.map((a) => ({
        via: a.via,
        status: a.status,
        bytes: a.html.length,
        shell: shellOf(a.html) || null,
        error: a.error,
      })),
    };
    rows.push(row);
    if (!answer) failures.push(`${target.merchant}: no priced page from any hop (${JSON.stringify(row.attempts)})`);
  }
  if (browser) await browser.browser.close().catch(() => undefined);
  console.log(JSON.stringify({ mode: forceBrowser ? "browser-only" : "ladder", rows }, null, 2));
  if (failures.length) {
    for (const f of failures) console.error(`FAIL ${f}`);
    process.exitCode = 1;
  }
}

const PANEL_QUERIES = [
  "laptop",
  "panadol",
  "cucumber",
  "air fryer",
  "headphones",
  "iPhone 17 Pro",
  "ps5",
  "milk",
  "detergent",
  "olive oil",
  "rice",
  "baby diapers",
];
const GATED = ["Lulu Hypermarket", "Next Store", "Ounass"];

async function runPanel() {
  const base = (process.env.BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
  const stamp = await fetch(`${base}/__commit.txt`, { signal: AbortSignal.timeout(20_000) })
    .then((r) => r.text())
    .catch(() => "");
  const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(45_000) })
    .then((r) => r.json())
    .catch(() => null);
  const rows = [];
  const failures = [];
  for (const query of PANEL_QUERIES) {
    let httpStatus = 0;
    const body = await fetch(`${base}/api/results-followup?q=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(180_000),
    })
      .then((r) => {
        httpStatus = r.status;
        return r.ok ? r.json() : null;
      })
      .catch(() => null);
    const answered = new Set(body?.responders?.answered ?? []);
    const empty = new Set(body?.responders?.answeredEmpty ?? []);
    const noResponse = new Set(body?.responders?.noResponse ?? []);
    const notes = Array.isArray(body?.notes) ? body.notes : [];
    const row = { query, http: httpStatus, lanes: {} };
    for (const merchant of GATED) {
      const note = notes.find((n) => n.merchant === merchant);
      const blocked = typeof note?.error === "string" && note.error.startsWith("blocked:");
      const state = answered.has(merchant)
        ? "answered"
        : empty.has(merchant)
          ? "answered-empty"
          : noResponse.has(merchant) || blocked
            ? "blocked"
            : "absent";
      row.lanes[merchant] = { state, hits: note?.hits ?? null, error: note?.error ?? null };
      if (state === "blocked" || state === "absent") {
        failures.push(
          `${query} / ${merchant}: ${state} (followup HTTP ${httpStatus})${note?.error ? ` — ${note.error.slice(0, 200)}` : ""}`,
        );
      }
    }
    rows.push(row);
  }
  console.log(JSON.stringify({ mode: "panel", base, stamp: stamp.trim(), health, queries: rows.length, rows }, null, 2));
  if (failures.length) {
    for (const f of failures) console.error(`FAIL ${f}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.PANEL === "1") await runPanel();
  else await runHops();
}
