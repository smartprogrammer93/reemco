/**
 * REEA-1221 — real-browser clearance tier for the lanes whose origin sits
 * behind a JavaScript challenge our plain hops cannot solve.
 *
 * Why this exists: `jsdClearedHtml` (the jsdom tier) clears the Cloudflare
 * managed challenge on the zones that only need cookies + a redirect, but
 * Next Store's zone answers `HTTP 403 / "Just a moment..."` to every plain
 * fetch AND to jsdom — measured 2026-11-26 from both the coder container and
 * the self-hosted egress: jsdom returned the 5.7 KB challenge shell after a
 * 4.5 s poll, while a real Chromium cleared the same URL and painted the
 * Magento result grid (13 `product-item-link` cards, 14 `data-price-amount`
 * values). Cloudflare's managed challenge binds its clearance to the TLS
 * fingerprint as well as the client IP, so reusing a browser's `cf_clearance`
 * cookie from Node's `fetch` still lands on the challenge; only a real browser
 * gets through.
 *
 * Cost control (rate-limit citizenship):
 *  - ONE browser and ONE context per process, reused across queries. The
 *    context keeps the clearance cookie, so the first navigation pays the
 *    challenge (~2 s) and later ones answer in ~1 s (measured: 905 ms and
 *    2.5 s on two consecutive queries after the first).
 *  - The cleared body is cached in the shared KV store per URL with a TTL, so
 *    a repeat query inside the window spends no browser round trip at all.
 *  - Every call is bounded and best-effort: a browser that cannot launch, a
 *    navigation that times out, or a page that never paints the selector all
 *    return `""`, and the caller keeps its existing degraded path.
 *  - `BROWSER_CLEARANCE=off` disables the tier without a code change (the
 *    box can drop ~200 MB of Chromium when it needs the room).
 */

import { getSharedKv } from "./kv";

/** Repeat queries inside this window replay the cached cleared body. */
const CLEARED_CACHE_TTL_S = 1_800;
/** Hard bound on one navigation. */
const NAV_TIMEOUT_MS = 12_000;
/** Bound on waiting for the page to paint the lane's content selector. */
const CONTENT_WAIT_MS = 12_000;

type BrowserLike = {
  newContext(options: Record<string, unknown>): Promise<ContextLike>;
  close(): Promise<void>;
};
type ContextLike = {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
};
type PageLike = {
  goto(url: string, options: Record<string, unknown>): Promise<unknown>;
  waitForFunction(fn: (arg: string) => boolean, arg: string, options: Record<string, unknown>): Promise<unknown>;
  content(): Promise<string>;
  close(): Promise<void>;
};

/** Desktop Chrome identity — the challenge is scored on this, so it is pinned. */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

let launch: Promise<{ browser: BrowserLike; context: ContextLike } | null> | null = null;

/**
 * The last thing that went wrong in this process's browser tier, or "".
 * Surfaced by the lane's blocked note and by the /api/echo probe so a
 * deployed-runtime failure is diagnosable from the served payload instead of
 * needing another guess-and-deploy cycle.
 */
let lastFailure = "";

export function browserLastError(): string {
  return lastFailure;
}

export interface BrowserProbe {
  enabled: boolean;
  ok: boolean;
  bytes: number;
  painted: boolean;
  ms: number;
  error?: string;
}

/** Read-only probe of the tier for /api/echo (no KV write, no lane state). */
export async function browserProbe(url: string, contentSelector: string): Promise<BrowserProbe> {
  const started = Date.now();
  if (!browserTierEnabled()) {
    return { enabled: false, ok: false, bytes: 0, painted: false, ms: 0 };
  }
  const shared = await getSharedBrowser();
  if (!shared) {
    return {
      enabled: true,
      ok: false,
      bytes: 0,
      painted: false,
      ms: Date.now() - started,
      error: lastFailure || "browser launch failed",
    };
  }
  let page: PageLike | null = null;
  try {
    page = await shared.context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page
      .waitForFunction((sel: string) => document.querySelector(sel) !== null, contentSelector, {
        timeout: CONTENT_WAIT_MS,
      })
      .catch(() => undefined);
    const html = await page.content();
    return {
      enabled: true,
      ok: html.length > 0,
      bytes: html.length,
      painted: html.includes(contentSelector.replace(/^[.#]/, "")),
      ms: Date.now() - started,
    };
  } catch (err) {
    lastFailure = err instanceof Error ? err.message : String(err);
    return { enabled: true, ok: false, bytes: 0, painted: false, ms: Date.now() - started, error: lastFailure };
  } finally {
    if (page) await page.close().catch(() => undefined);
  }
}

/**
 * Gate for the tier. Explicit opt-out wins; a test run is hermetic by default
 * (the unit suite must not pay a Chromium launch), and anything else — the
 * self-hosted runtime, local dev — runs the browser.
 */
export function browserTierEnabled(): boolean {
  const flag = (process.env.BROWSER_CLEARANCE ?? "").toLowerCase();
  if (flag === "off") return false;
  if (flag === "on") return true;
  return process.env.NODE_ENV !== "test";
}

function disabled(): boolean {
  return !browserTierEnabled();
}

/**
 * Launch the shared browser once per process. Any failure (package missing on
 * a trimmed deploy, no executable for the platform) resolves to null and the
 * tier degrades to the existing hops.
 */
async function getSharedBrowser(): Promise<{ browser: BrowserLike; context: ContextLike } | null> {
  if (disabled()) return null;
  if (!launch) {
    launch = (async () => {
      try {
        const { chromium } = await import("playwright-core");
        const sparticuz = (await import("@sparticuz/chromium")).default;
        const executablePath = await sparticuz.executablePath();
        const browser = (await chromium.launch({
          executablePath,
          args: sparticuz.args,
          headless: true,
        })) as unknown as BrowserLike;
        const context = await browser.newContext({
          userAgent: BROWSER_UA,
          locale: "en-US",
          viewport: { width: 1366, height: 900 },
          extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9" },
        });
        return { browser, context };
      } catch (err) {
        lastFailure = err instanceof Error ? err.message : String(err);
        return null;
      }
    })();
  }
  const shared = await launch;
  // A crashed browser must not poison the process for the rest of its life.
  if (shared && !(await isAlive(shared))) {
    launch = null;
    return getSharedBrowser();
  }
  return shared;
}

async function isAlive(shared: { browser: BrowserLike; context: ContextLike }): Promise<boolean> {
  try {
    await shared.context.newPage().then((p) => p.close());
    return true;
  } catch {
    try {
      await shared.browser.close();
    } catch {
      // already gone
    }
    return false;
  }
}

function cacheKey(url: string): string {
  return `browser-cleared:${url}`;
}

/**
 * Fetch `url` through the shared browser and return the painted HTML once the
 * page carries `contentSelector` (or the bounded wait expires — the caller's
 * own presence gate decides whether the body is usable).
 */
export async function browserClearedHtml(url: string, contentSelector: string): Promise<string> {
  if (disabled()) return "";
  const kv = getSharedKv();
  const key = cacheKey(url);
  if (kv) {
    try {
      const cached = await kv.get(key);
      if (cached) return cached;
    } catch {
      // store hiccup — fall through to the browser
    }
  }
  const shared = await getSharedBrowser();
  if (!shared) return "";
  let page: PageLike | null = null;
  try {
    page = await shared.context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page
      .waitForFunction((sel: string) => document.querySelector(sel) !== null, contentSelector, {
        timeout: CONTENT_WAIT_MS,
      })
      .catch(() => undefined);
    const html = await page.content();
    if (html && kv) {
      // Best-effort write: a store hiccup must not fail the lane.
      await kv.set(key, html, CLEARED_CACHE_TTL_S).catch(() => false);
    }
    return html;
  } catch (err) {
    lastFailure = err instanceof Error ? err.message : String(err);
    return "";
  } finally {
    if (page) await page.close().catch(() => undefined);
  }
}
