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

import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getSharedKv } from "./kv";

/** Repeat queries inside this window replay the cached cleared body. */
const CLEARED_CACHE_TTL_S = 1_800;
/** Hard bound on one navigation. */
const NAV_TIMEOUT_MS = 12_000;
/** Bound on waiting for the page to paint the lane's content selector. */
const CONTENT_WAIT_MS = 12_000;

type BrowserLike = {
  newContext(options: Record<string, unknown>): Promise<ContextLike>;
  version?(): string;
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
/** Which launch arg set answered (-1 until a browser is up). */
let lastLaunchArgs = -1;
/** The launched Chromium's own version string, or "" until it answers. */
let browserVersion = "";
/**
 * REEA-1221 — the arg set the process has climbed to. It only ever moves
 * forward: once a set has proven to kill the browser on this host, retrying it
 * is wasted time.
 */
let argSetIndex = 0;

/**
 * The launch ladder. Set 0 is the package's serverless shape (right on Lambda).
 * Set 1 drops the single-process/zygote pair and the in-process GPU, which is
 * what killed the browser on the self-hosted box at navigation time
 * ("Target page, context or browser has been closed", measured 2026-11-26).
 * Set 2 is a plain headless shell with the GPU disabled outright.
 */
function launchArgSets(base: string[]): string[][] {
  const noSingle = base.filter(
    (a) => a !== "--single-process" && a !== "--no-zygote" && a !== "--in-process-gpu",
  );
  const noSwiftshader = noSingle.filter(
    (a) => !a.startsWith("--use-gl") && !a.startsWith("--use-angle") && a !== "--ignore-gpu-blocklist",
  );
  return [base, [...noSingle, "--disable-gpu"], [...noSwiftshader, "--disable-gpu"]];
}

export function browserLastError(): string {
  return lastFailure;
}

export interface BrowserProbe {
  enabled: boolean;
  ok: boolean;
  bytes: number;
  painted: boolean;
  ms: number;
  /** Which launch arg set answered (-1 = none). */
  args: number;
  /** Staged self-test: what the runtime actually managed to do. */
  stages: {
    libs: boolean;
    exeBytes: number;
    launched: boolean;
    version: string;
    gotoOk: boolean;
  };
  error?: string;
}

/** Read-only probe of the tier for /api/echo (no KV write, no lane state). */
export async function browserProbe(url: string, contentSelector: string): Promise<BrowserProbe> {
  const started = Date.now();
  if (!browserTierEnabled()) {
    return {
      enabled: false,
      ok: false,
      bytes: 0,
      painted: false,
      ms: 0,
      args: -1,
      stages: { libs: false, exeBytes: 0, launched: false, version: "", gotoOk: false },
    };
  }
  const { html, error } = await navigate(url, contentSelector);
  const exe = join(tmpdir(), "chromium");
  return {
    enabled: true,
    ok: html.length > 0 && !error,
    bytes: html.length,
    painted: html.includes(contentSelector.replace(/^[.#]/, "")),
    ms: Date.now() - started,
    args: lastLaunchArgs,
    stages: {
      libs: existsSync(join(tmpdir(), "al2023", "lib", "libnspr4.so")),
      exeBytes: existsSync(exe) ? statSync(exe).size : 0,
      launched: lastLaunchArgs >= 0,
      version: browserVersion,
      gotoOk: html.length > 0,
    },
    ...(error ? { error } : {}),
  };
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
        const sparticuzMod = (await import("@sparticuz/chromium")) as unknown as {
          default: { executablePath(): Promise<string>; args: string[] };
          inflate(filePath: string): Promise<string>;
          setupLambdaEnvironment(baseLibPath: string): void;
        };
        const sparticuz = sparticuzMod.default;
        // REEA-1221 — on a non-AL2023 host (the self-hosted image is Debian
        // bookworm-slim) the package does NOT extract its bundled shared
        // libraries, so /tmp/chromium dies with
        // "error while loading shared libraries: libnspr4.so" — measured on the
        // served head 2026-11-26. Extract the al2023 tar and put its lib dir on
        // the loader path before launching. Best-effort: a host that already
        // has the libs system-wide (the coder container) simply skips this.
        const libDir = join(tmpdir(), "al2023", "lib");
        if (!existsSync(libDir)) {
          // The package's own bin path is not exported, and a bundler rewrites
          // import.meta.url, so probe the candidate roots this process can
          // actually see (the standalone bundle and a plain repo checkout).
          const candidates = [
            join(process.cwd(), "node_modules", "@sparticuz", "chromium", "bin", "al2023.tar.br"),
            join(process.cwd(), "..", "node_modules", "@sparticuz", "chromium", "bin", "al2023.tar.br"),
          ];
          try {
            const entry = createRequire(import.meta.url).resolve("@sparticuz/chromium");
            if (entry.startsWith("/")) {
              candidates.push(join(dirname(entry), "..", "bin", "al2023.tar.br"));
            }
          } catch {
            // bundler-resolved path — the cwd candidates above still apply
          }
          const archive = candidates.find((c) => existsSync(c));
          if (archive) await sparticuzMod.inflate(archive);
        }
        if (existsSync(libDir)) sparticuzMod.setupLambdaEnvironment(libDir);
        const executablePath = await sparticuz.executablePath();
        // REEA-1221 — two arg sets, tried in order. The package's serverless
        // set runs Chromium with --single-process/--no-zygote, which is right
        // on Lambda but died on the self-hosted box ("Target page, context or
        // browser has been closed" right after launch, measured 2026-11-26).
        // The fallback keeps the same headless identity without the
        // single-process/zygote pair and with the GPU path disabled, which is
        // the stable shape on a long-lived server. Whichever answers is what
        // the process keeps.
        let browser: BrowserLike | null = null;
        for (let i = argSetIndex; i < launchArgSets(sparticuz.args).length && !browser; i++) {
          try {
            browser = (await chromium.launch({
              executablePath,
              args: launchArgSets(sparticuz.args)[i],
              headless: true,
              // The child must see the lib path set above.
              env: process.env,
            })) as unknown as BrowserLike;
            argSetIndex = i;
            lastLaunchArgs = i;
          } catch (err) {
            lastFailure = err instanceof Error ? err.message : String(err);
            // ETXTBSY: the freshly extracted binary is still being written on
            // a cold container — one short breath, then the same set retries.
            if (/ETXTBSY/.test(lastFailure)) {
              await new Promise((r) => setTimeout(r, 400));
              i -= 1;
            }
          }
        }
        if (!browser) return null;
        try {
          browserVersion = browser.version?.() ?? "";
        } catch {
          browserVersion = "";
        }
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

/**
 * REEA-1221 — navigate inside one bounded attempt. A browser that died between
 * the liveness check and the navigation is relaunched once (the launch ladder
 * in getSharedBrowser picks the arg set that works on this host), so a single
 * crash does not blank the lane for the rest of the process's life.
 */
async function navigate(
  url: string,
  contentSelector: string,
): Promise<{ html: string; error?: string }> {
  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      // A navigation that kills the browser is an arg-set verdict, not a
      // transient: climb the ladder before relaunching.
      if (argSetIndex < 2) argSetIndex += 1;
      launch = null;
    }
    const shared = await getSharedBrowser();
    if (!shared) return { html: "", error: lastFailure || "browser launch failed" };
    let page: PageLike | null = null;
    try {
      page = await shared.context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      await page
        .waitForFunction((sel: string) => document.querySelector(sel) !== null, contentSelector, {
          timeout: CONTENT_WAIT_MS,
        })
        .catch(() => undefined);
      return { html: await page.content() };
    } catch (err) {
      lastFailure = err instanceof Error ? err.message : String(err);
      // A dead browser is not going to answer this attempt; the next loop
      // relaunches.
      if (!/closed|disconnected|crash/i.test(lastFailure)) return { html: "", error: lastFailure };
    } finally {
      if (page) await page.close().catch(() => undefined);
    }
  }
  return { html: "", error: lastFailure };
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
  const { html } = await navigate(url, contentSelector);
  if (html && kv) {
    // Best-effort write: a store hiccup must not fail the lane.
    await kv.set(key, html, CLEARED_CACHE_TTL_S).catch(() => false);
  }
  return html;
}
