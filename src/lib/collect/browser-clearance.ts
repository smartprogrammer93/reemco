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
 *
 * REEA-1241 — the relay/page bodies are untrusted upstream input, so every
 * hop now rides the bounded body reader (`readBodyCapped`, 2 MB here) and the
 * shared-store cache refuses any value above 256 KB. Measured 2026-11-26 on
 * the served head: `jina-cleared:*` alone held 641 keys / 371.8 MB of a 384 MB
 * `allkeys-lru` keyspace that also carries `ratelimit:*` and `metrics:*`, so
 * cache churn could evict the per-IP gate or a weekly counter. A page too big
 * to cache still answers THIS query from memory (live-data fidelity); it just
 * no longer occupies the shared store.
 */

import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getSharedKv, type SharedKv } from "./kv";
import { readBodyCapped } from "./read-body";

/** Repeat queries inside this window replay the cached cleared body. */
const CLEARED_CACHE_TTL_S = 1_800;
/** REEA-1241 — hard cap on any relay answer (2 MiB). A fatter body is
 *  cancelled mid-stream and degrades to `""` instead of being buffered whole
 *  into the process. */
export const RELAY_MAX_RESPONSE_BODY_BYTES = 2 * 1024 * 1024;
/** REEA-1241 — a browser-painted document is materialized by playwright, so
 *  it cannot be streamed; it is trimmed to this cap before the lane parses it
 *  or the cache sees it. */
export const BROWSER_MAX_CONTENT_BYTES = 2 * 1024 * 1024;
/** REEA-1241 — no clearance answer larger than this enters the shared KV
 *  store. 256 KB keeps the cache namespace bounded well under half of the
 *  384 MB allkeys-lru ceiling even at the measured key counts, so `allkeys-lru`
 *  can no longer evict `ratelimit:*` / `metrics:*` because of page churn. */
export const CLEARANCE_CACHE_MAX_VALUE_BYTES = 256 * 1024;
/** Hard bound on one navigation. */
const NAV_TIMEOUT_MS = 12_000;
/** Bound on waiting for the page to paint the lane's content selector. The
 *  self-hosted box needs longer than the old 12 s for the managed challenge to
 *  step aside (measured 2026-11-26: 4.7 KB shell still there at 12.4 s). */
const CONTENT_WAIT_MS = 10_000;

type BrowserLike = {
  newContext(options: Record<string, unknown>): Promise<ContextLike>;
  version?(): string;
  isConnected?(): boolean;
  on?(event: string, cb: () => void): void;
  close(): Promise<void>;
};
type ContextLike = {
  newPage(): Promise<PageLike>;
  addCookies(cookies: StoredCookie[]): Promise<void>;
  cookies(urls?: string): Promise<StoredCookie[]>;
  addInitScript(script: () => void): Promise<void>;
  close(): Promise<void>;
};
export type PageLike = {
  goto(url: string, options: Record<string, unknown>): Promise<unknown>;
  waitForFunction(fn: (arg: string) => boolean, arg: string, options: Record<string, unknown>): Promise<unknown>;
  content(): Promise<string>;
  close(): Promise<void>;
};

/** Desktop Chrome identity — the challenge is scored on this, so it is pinned. */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/**
 * REEA-1242 — the client hints, not the UA string, are what Cloudflare scores.
 * The serverless Chromium this tier launches is a headless shell, so it emits
 * `sec-ch-ua: ...HeadlessChrome...` no matter what `userAgent` the context
 * sets. Measured on the production egress 2026-11-26, same URL, same IP, same
 * second: headless hints -> HTTP 403 "Sorry, you have been blocked"; these
 * hints -> HTTP 200 / 908 KB with `app-product-card` priced cards (LuLu) and
 * the `OnlineStore` island (Ounass). So the hint set is pinned to the UA we
 * claim, and every context carries it.
 */
const BROWSER_HINTS: Record<string, string> = {
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

/**
 * REEA-1242 — the stealth init script every page gets. `navigator.webdriver`
 * is the first thing a bot score reads, and headless Chromium sets it to true;
 * a real desktop browser also ships plugin entries and a `chrome` runtime
 * object, so the shape is completed rather than only the flag cleared.
 */
const STEALTH_INIT_SCRIPT = (): void => {
  Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
  (window as unknown as { chrome?: unknown }).chrome = { runtime: {} };
};

/**
 * REEA-1242 — classify a clearance body. Three states matter and they lead to
 * different actions, so they are named rather than inferred from a selector
 * miss:
 *  - `challenge`: Cloudflare's managed challenge ("Just a moment..."), which a
 *    real browser resolves on its own if given a moment;
 *  - `block`: the WAF's outright refusal ("Sorry, you have been blocked" /
 *    "Attention Required! | Cloudflare"). There is nothing to solve — the
 *    request was refused at the edge before the origin answered — so waiting
 *    the whole content window only burns time;
 *  - `""`: a body that carries the page.
 */
export type ClearanceShell = "" | "challenge" | "block";

export function classifyClearanceBody(html: string): ClearanceShell {
  if (!html) return "block";
  if (/Sorry, you have been blocked|Attention Required!\s*\|\s*Cloudflare|cf-error-details/i.test(html)) {
    return "block";
  }
  // Only the shell's own markers count. `/cdn-cgi/challenge-platform/` scripts
  // are also injected into CLEARED pages (Turnstile, bot-management JS), so
  // matching that string would reject the very page the browser painted —
  // measured 2026-11-26: the cleared 908 KB LuLu list page carries it.
  if (/Just a moment\.\.\.|Enable JavaScript and cookies to continue|cf-browser-verification|cf-challenge-running/i.test(html)) {
    return "challenge";
  }
  return "";
}

/**
 * REEA-1242 — the `cf_clearance` store. Cloudflare binds a clearance cookie to
 * the client IP and the TLS/JS fingerprint that earned it, so it is only
 * reusable from the same egress. The key therefore carries host + egress IP,
 * and the value carries the cookie set plus its own expiry: a relaunched
 * browser (or a fresh context) replays the clearance instead of paying another
 * challenge. Best-effort in both directions — a KV hiccup costs one challenge.
 */
const CLEARANCE_TTL_S = 60 * 60;
const CLEARANCE_DEFAULT_AGE_MS = 30 * 60 * 1000;
const IP_ECHO_URL = "https://api.ipify.org?format=json";
const IP_ECHO_TIMEOUT_MS = 4_000;
let cachedEgressIp: string | null = null;

type StoredCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
};

async function egressIp(): Promise<string> {
  if (cachedEgressIp != null) return cachedEgressIp;
  try {
    const res = await fetch(IP_ECHO_URL, { signal: AbortSignal.timeout(IP_ECHO_TIMEOUT_MS) });
    if (!res.ok) return "";
    const body = (await res.json()) as { ip?: unknown } | null;
    cachedEgressIp = typeof body?.ip === "string" ? body.ip : "";
  } catch {
    // No echo answer: the key degrades to host-only, which is still correct —
    // just less precise across an egress change.
    cachedEgressIp = "";
  }
  return cachedEgressIp;
}

function clearanceKey(host: string, ip: string): string {
  return `cf-clearance:${host}:${ip || "unknown"}`;
}

async function readClearance(host: string): Promise<StoredCookie[]> {
  const kv = getSharedKv();
  if (!kv) return [];
  try {
    const raw = await kv.get(clearanceKey(host, await egressIp()));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { at?: number; cookies?: StoredCookie[] } | null;
    if (!parsed || !Array.isArray(parsed.cookies)) return [];
    const age = Date.now() - (parsed.at ?? 0);
    if (age > CLEARANCE_DEFAULT_AGE_MS && parsed.cookies.every((c) => c.expires > 0 && c.expires * 1000 < Date.now())) {
      return [];
    }
    return parsed.cookies.filter((c) => !c.expires || c.expires * 1000 > Date.now());
  } catch {
    return [];
  }
}

async function writeClearance(host: string, cookies: StoredCookie[]): Promise<void> {
  const kv = getSharedKv();
  if (!kv || cookies.length === 0) return;
  try {
    await kv.set(clearanceKey(host, await egressIp()), JSON.stringify({ at: Date.now(), cookies }), CLEARANCE_TTL_S);
  } catch {
    // Best-effort: the next navigation pays one challenge.
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

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
let argSetIndex = 1;
/**
 * REEA-1221 — a no-paint circuit breaker. Measured on the self-hosted box
 * 2026-11-26: Chromium launches and navigates, but this zone's managed challenge
 * never steps aside for it (25 s of waiting, 4.7 KB shell, on both the
 * serverless set and the full-browser set). Paying that wait on every dispatch
 * would starve the lane's relay fallback, so two consecutive no-paint results
 * take the browser out of the ladder for ten minutes and the relays answer.
 */
const BROWSER_NO_PAINT_LIMIT = 2;
const BROWSER_NO_PAINT_COOLDOWN_MS = 10 * 60 * 1000;
let browserNoPaintStreak = 0;
let browserCooldownUntil = 0;

/**
 * The launch ladder. Set 0 is the package's serverless shape (right on Lambda,
 * but its --single-process renderer never clears this zone's managed challenge
 * on the self-hosted box: measured 2026-11-26, 25 s of waiting still left the
 * 4.7 KB "Just a moment" shell). Set 1 drops the single-process/zygote pair and
 * the in-process GPU, which is the full-browser shape a challenge can actually
 * solve. Set 2 is a plain headless shell with the GPU disabled outright.
 *
 * The process starts at set 1: the challenge is the reason this tier exists, and
 * set 0 is the one that cannot solve it here.
 */
function launchArgSets(base: string[]): string[][] {
  const noSingle = base.filter(
    (a) => a !== "--single-process" && a !== "--no-zygote" && a !== "--in-process-gpu",
  );
  const noSwiftshader = noSingle.filter(
    (a) => !a.startsWith("--use-gl") && !a.startsWith("--use-angle") && a !== "--ignore-gpu-blocklist",
  );
  const lean = [
    "--blink-settings=imagesEnabled=false",
    "--renderer-process-limit=1",
    "--js-flags=--max-old-space-size=192",
    "--window-size=1024,768",
  ];
  return [
    base,
    [...noSingle, "--disable-gpu", ...lean],
    [...noSwiftshader, "--disable-gpu", ...lean],
  ];
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
 * REEA-1241 — byte length as the shared store would hold the value. The caps
 * are byte caps, not character counts: a page of Arabic or CJK text can be
 * three bytes per UTF-16 unit, so a length-only check would under-count it.
 */
function storedBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/** REEA-1241 — trim a materialized document to at most `maxBytes` of UTF-8. */
export function capContent(text: string, maxBytes: number = BROWSER_MAX_CONTENT_BYTES): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  return bytes.subarray(0, maxBytes).toString("utf8");
}

/**
 * REEA-1241 — read a relay answer through the shared bounded reader. An
 * oversized answer aborts mid-stream and degrades to `""` (the lane keeps its
 * existing blocked/degraded note) instead of buffering the whole document.
 */
async function readCappedBody(res: Response, maxBytes: number, label: string): Promise<string> {
  try {
    return await readBodyCapped(res, maxBytes);
  } catch {
    lastFailure = `${label} answer exceeded the ${maxBytes}-byte cap`;
    return "";
  }
}

/**
 * REEA-1241 — replay a cached clearance body, and drop any entry that
 * predates the value cap. Deleting instead of returning it keeps the store
 * draining on replay: an old 1 MB page would otherwise sit in the
 * `allkeys-lru` keyspace until its original TTL expired, still competing with
 * the control keys.
 *
 * `accepts` is the lane's own presence gate (REEA-1235 made the reader-relay
 * signature a marker SET, so the caller passes its predicate instead of one
 * literal token); omit it for the browser tier, which caches any painted body.
 */
async function readClearedBody(
  kv: SharedKv | null,
  key: string,
  accepts?: (body: string) => boolean,
): Promise<string | null> {
  if (!kv) return null;
  try {
    const cached = await kv.get(key);
    if (!cached) return null;
    if (storedBytes(cached) > CLEARANCE_CACHE_MAX_VALUE_BYTES && kv.del) {
      // Best-effort: a store hiccup must not fail the lane.
      await kv.del(key).catch(() => false);
    }
    return accepts === undefined || accepts(cached) ? cached : null;
  } catch {
    return null;
  }
}

/**
 * REEA-1241 — write a clearance body only when it fits the value cap. A
 * larger body still served this query (it is the live page the lane parses);
 * it simply never enters the shared store.
 */
async function cacheClearedBody(
  kv: SharedKv | null,
  key: string,
  value: string,
  ttlSeconds: number,
): Promise<boolean> {
  if (!kv) return false;
  if (storedBytes(value) > CLEARANCE_CACHE_MAX_VALUE_BYTES) return false;
  return kv.set(key, value, ttlSeconds).catch(() => false);
}

/**
 * REEA-1241 — the browser tier's only body read. playwright materializes the
 * whole document before handing it back, so the cap is enforced on the string:
 * an oversized page is trimmed to the cap rather than parsed (and cached) in
 * full.
 */
export async function readPageContent(page: PageLike): Promise<string> {
  const html = await page.content();
  if (storedBytes(html) <= BROWSER_MAX_CONTENT_BYTES) return html;
  lastFailure = `browser page exceeded the ${BROWSER_MAX_CONTENT_BYTES}-byte cap; trimmed`;
  return capContent(html);
}

/**
 * Launch the shared browser once per process. Any failure (package missing on
 * a trimmed deploy, no executable for the platform) resolves to null and the
 * tier degrades to the existing hops.
 */
async function getSharedBrowser(): Promise<{ browser: BrowserLike; context: ContextLike } | null> {
  if (disabled()) return null;
  if (Date.now() < browserCooldownUntil) return null;
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
        browser.on?.("disconnected", () => {
          launch = null;
        });
        try {
          browserVersion = browser.version?.() ?? "";
        } catch {
          browserVersion = "";
        }
        const context = await browser.newContext({
          userAgent: BROWSER_UA,
          locale: "en-US",
          viewport: { width: 1366, height: 900 },
          // REEA-1242 — the hints are pinned with the UA. Without this the
          // headless shell advertises `HeadlessChrome` in `sec-ch-ua` and the
          // WAF blocks a page it would otherwise serve (measured 2026-11-26).
          extraHTTPHeaders: BROWSER_HINTS,
        });
        await context.addInitScript(STEALTH_INIT_SCRIPT);
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
    const host = safeHost(url);
    try {
      // REEA-1242 — replay a clearance this egress already earned before
      // paying for another challenge. Bound to host + egress IP by the store.
      if (host) {
        const stored = await readClearance(host);
        if (stored.length > 0) await shared.context.addCookies(stored).catch(() => undefined);
      }
      page = await shared.context.newPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      // REEA-1242 — a WAF block is not a challenge: there is nothing to solve,
      // so return immediately instead of burning the content window, and let
      // the lane fall through to its relay hop.
      const first = await page.content();
      if (classifyClearanceBody(first) === "block") {
        lastFailure = `cloudflare WAF block (not a challenge) on ${host}`;
        return { html: "", error: lastFailure };
      }
      await page
        .waitForFunction((sel: string) => document.querySelector(sel) !== null, contentSelector, {
          timeout: CONTENT_WAIT_MS,
        })
        .catch(() => undefined);
      // REEA-1241 — bounded: a page bigger than the cap is trimmed before the
      // presence gate, the lane parser, and the cache ever see it.
      const html = await readPageContent(page);
      // REEA-1242 — a resolved challenge that still carries the shell is not
      // an answer: do not hand it back, and do not cache it.
      const shell = classifyClearanceBody(html);
      if (shell) {
        lastFailure =
          shell === "challenge" ? `managed challenge unresolved on ${host}` : `cloudflare WAF block on ${host}`;
        return { html: "", error: lastFailure };
      }
      // Persist the clearance this navigation earned (cf_clearance / __cf_bm).
      if (host) {
        const cookies = await shared.context.cookies().catch(() => [] as StoredCookie[]);
        const keep = cookies.filter((c) => /^cf_clearance$|^__cf_bm$|^_cfuvid$/.test(c.name));
        if (keep.length > 0) await writeClearance(host, keep);
      }
      // REEA-1221 — a no-paint result feeds the circuit breaker above; the
      // ladder still climbs only when a navigation DIES (escalating on no-paint
      // reached the lean shell and crashed it with SIGTRAP).
      const token = contentSelector.replace(/^[.#]/, "");
      if (html.includes(token)) {
        browserNoPaintStreak = 0;
      } else {
        browserNoPaintStreak += 1;
        if (browserNoPaintStreak >= BROWSER_NO_PAINT_LIMIT) {
          browserCooldownUntil = Date.now() + BROWSER_NO_PAINT_COOLDOWN_MS;
          lastFailure = "browser painted nothing twice — relays take over for ten minutes";
        }
      }
      return { html };
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

/**
 * REEA-1221 — liveness is read from the browser's own connection state, never
 * by opening and closing a probe page: this Chromium runs with
 * --no-startup-window, and closing the LAST page can end the process on the
 * self-hosted box (the next goto then reports "Target page, context or browser
 * has been closed" — measured 2026-11-26, which is exactly what the old
 * page-open probe did right before every navigation).
 */
async function isAlive(shared: { browser: BrowserLike; context: ContextLike }): Promise<boolean> {
  if (typeof shared.browser.isConnected === "function") {
    return shared.browser.isConnected() !== false;
  }
  try {
    await shared.context.newPage().then((p) => p.close());
    return true;
  } catch {
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
  const token = contentSelector.replace(/^[.#]/, "");
  // REEA-1242 — only replay a body that carries the lane's content. The old hop
  // cached whatever came back, so one WAF-block navigation pinned that URL to
  // the block page for the whole TTL.
  const cached = await readClearedBody(kv, key, (body) => body.includes(token));
  if (cached) return cached;
  const { html } = await navigate(url, contentSelector);
  if (html && html.includes(token)) await cacheClearedBody(kv, key, html, CLEARED_CACHE_TTL_S);
  return html;
}

/**
 * REEA-1221 — relay clearance tier. When the box cannot run Chromium to the
 * end of a navigation, the lane still needs a live fetch of the challenged
 * page. A reader relay renders it from ITS egress and hands back the painted
 * HTML/markdown, which is the same live page a shopper's browser would see —
 * no bundled catalogue, no cached snapshot.
 *
 * REEA-1242 — capacity is the constraint, so every relay call now passes a
 * per-endpoint budget and a per-hop cooldown:
 *  - the free reader tier publishes 20 requests per 60 s (`x-ratelimit-limit`),
 *    and the old hop answered a single 429 with a silence that outlived the
 *    limit — that is how a lane that had a working relay settled `blocked:`
 *    for the rest of the window;
 *  - the budget is a sliding window, a call waits only a bounded moment for a
 *    slot, and a 429 sets a cooldown read from the answer's own `retry-after`
 *    (floor 20 s, cap two minutes) instead of a blanket pause;
 *  - each hop owns its own cooldown, so a rate-limited markdown render no
 *    longer silences the html hop (they ride different quotas);
 *  - `JINA_API_KEY` in the environment lifts the free ceiling (the paid reader
 *    tier answers 200 rpm) without a code change, and the key is only ever
 *    read from the environment — never logged, never in a comment.
 *
 * Politeness: every answer is cached in the shared KV store per URL, so a
 * repeat query inside the window spends no relay call; every call is bounded
 * and best-effort, and the lane's own presence gate decides whether the body
 * is usable. The relay is the LAST hop: a working browser or a plain challenge
 * pass never reaches it.
 */
const RELAY_ENDPOINT = "https://api.microlink.io/";
const JINA_ENDPOINT = "https://r.jina.ai/";
// REEA-1241 — 30 min: only bodies under the cache value cap are stored now, and
// a shorter residency keeps the cache namespace small even when many distinct
// queries are in flight.
const RELAY_TTL_S = 30 * 60;
const RELAY_TIMEOUT_MS = 12_000;
const JINA_TIMEOUT_MS = 20_000;
/** Never silence a hop for less than this, nor for longer than two minutes. */
const RELAY_COOLDOWN_FLOOR_MS = 20_000;
const RELAY_COOLDOWN_CAP_MS = 120_000;
/** A lane will wait this long for a relay slot before it takes the degraded path. */
const RELAY_MAX_WAIT_MS = 2_500;

export type RelayLimits = { limit: number; windowMs: number };

/** Free reader tier: 20 requests / 60 s (`x-ratelimit-limit: 20, 20;w=60`). */
const JINA_FREE_LIMITS: RelayLimits = { limit: 20, windowMs: 60_000 };
/** Paid reader tier with an API key: 200 requests / 60 s. */
const JINA_KEYED_LIMITS: RelayLimits = { limit: 200, windowMs: 60_000 };
/** Free meta-relay tier: 50 requests / day per egress. */
const MICROLINK_FREE_LIMITS: RelayLimits = { limit: 50, windowMs: 24 * 60 * 60 * 1000 };

function envInt(name: string): number {
  const raw = process.env[name];
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** The reader tier's limits, lifted by an API key or an explicit override. */
export function jinaLimits(): RelayLimits {
  const override = envInt("JINA_RPM");
  if (override > 0) return { limit: override, windowMs: 60_000 };
  return process.env.JINA_API_KEY ? JINA_KEYED_LIMITS : JINA_FREE_LIMITS;
}

function microlinkLimits(): RelayLimits {
  const override = envInt("MICROLINK_RPD");
  if (override > 0) return { limit: override, windowMs: 24 * 60 * 60 * 1000 };
  return MICROLINK_FREE_LIMITS;
}

/**
 * How long until a sliding-window budget admits one more call. Pure, so the
 * pacing is pinned by a unit test instead of being measured against a live
 * relay.
 */
export function relayWaitMs(hits: readonly number[], now: number, limits: RelayLimits): number {
  if (limits.limit <= 0) return 0;
  const recent = hits.filter((t) => now - t < limits.windowMs);
  if (recent.length < limits.limit) return 0;
  const oldest = Math.min(...recent);
  return Math.max(0, limits.windowMs - (now - oldest));
}

type RelayState = { hits: number[]; cooldownUntil: number };

const relayStates = new Map<string, RelayState>();

function relayState(id: string): RelayState {
  let state = relayStates.get(id);
  if (!state) {
    state = { hits: [], cooldownUntil: 0 };
    relayStates.set(id, state);
  }
  return state;
}

/** Reset the in-process pacing state (used by the probe and by tests). */
export function resetRelayState(): void {
  relayStates.clear();
}

/**
 * Take one slot on a relay's budget, waiting at most RELAY_MAX_WAIT_MS. Returns
 * false when the hop must degrade this call (cooldown or spent budget), and
 * leaves the reason in `lastFailure` so the lane's note names it.
 */
async function acquireRelaySlot(id: string, limits: RelayLimits): Promise<boolean> {
  const state = relayState(id);
  const now = Date.now();
  if (now < state.cooldownUntil) {
    lastFailure = `${id} relay cooling down after a rate-limit answer`;
    return false;
  }
  state.hits = state.hits.filter((t) => now - t < limits.windowMs);
  const wait = relayWaitMs(state.hits, now, limits);
  if (wait > RELAY_MAX_WAIT_MS) {
    lastFailure = `${id} relay budget spent (${limits.limit}/${Math.round(limits.windowMs / 1000)}s)`;
    return false;
  }
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  state.hits.push(Date.now());
  return true;
}

/**
 * Set a hop's cooldown from the relay's own answer. `retry-after` wins when it
 * is present; otherwise the hop rests one window. Never shorter than the floor
 * (a relay that answers 429 immediately would otherwise be hammered).
 */
function applyRelayCooldown(id: string, retryAfterSeconds: number, windowMs: number): void {
  const requested = retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : windowMs;
  const ms = Math.min(RELAY_COOLDOWN_CAP_MS, Math.max(RELAY_COOLDOWN_FLOOR_MS, requested));
  relayState(id).cooldownUntil = Date.now() + ms;
}

function retryAfterSeconds(res: Response): number {
  const raw = res.headers.get("retry-after");
  if (!raw) return 0;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
}

/**
 * Gate for the relay hop. Same posture as the browser tier: an explicit opt-out
 * wins, a test run is hermetic (the unit suite must not depend on the public
 * internet — measured in CI 2026-11-26, a real relay call inside the fake-fetch
 * tests turned 1 expected product into 10 and blew the 5 s per-test budget),
 * and the self-hosted runtime runs it.
 */
export function relayTierEnabled(): boolean {
  const flag = (process.env.CLEARANCE_RELAY ?? "").toLowerCase();
  if (flag === "off") return false;
  if (flag === "on") return true;
  return process.env.NODE_ENV !== "test";
}

/**
 * The reader tier's request headers. The API key, when configured, rides an
 * Authorization header read from the environment — never logged, never baked
 * into the image.
 */
export function jinaHeaders(mode: "html" | "markdown"): Record<string, string> {
  const headers: Record<string, string> = {
    "x-respond-with": mode,
    "x-timeout": mode === "markdown" ? "45" : "40",
    accept: mode === "markdown" ? "text/plain" : "text/html",
  };
  if (process.env.JINA_API_KEY) headers.authorization = `Bearer ${process.env.JINA_API_KEY}`;
  return headers;
}

export async function relayClearedHtml(url: string, contentSelector: string): Promise<string> {
  if (!relayTierEnabled()) return "";
  const token = contentSelector.replace(/^[.#]/, "");
  const kv = getSharedKv();
  const key = `relay-cleared:${url}`;
  const cached = await readClearedBody(kv, key, (body) => body.includes(token));
  if (cached) return cached;
  if (!(await acquireRelaySlot("microlink-html", microlinkLimits()))) return "";
  try {
    const target = `${RELAY_ENDPOINT}?url=${encodeURIComponent(url)}&meta=false&data.html.selector=body`;
    const res = await fetch(target, { signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
    if (!res.ok) {
      lastFailure = `relay HTTP ${res.status}`;
      if (res.status === 429 || res.status === 503) {
        applyRelayCooldown("microlink-html", retryAfterSeconds(res), microlinkLimits().windowMs);
      }
      return "";
    }
    // REEA-1241 — bounded read: a fat microlink answer aborts at the cap and
    // degrades to "" instead of buffering the whole document.
    const text = await readCappedBody(res, RELAY_MAX_RESPONSE_BODY_BYTES, "relay");
    if (!text) return "";
    let payload: { data?: { html?: unknown } } | null = null;
    try {
      payload = JSON.parse(text) as { data?: { html?: unknown } } | null;
    } catch {
      lastFailure = "relay answered non-JSON";
      return "";
    }
    const html = typeof payload?.data?.html === "string" ? payload.data.html : "";
    if (!html.includes(token)) {
      lastFailure = "relay answered without the lane's content selector";
      return "";
    }
    await cacheClearedBody(kv, key, html, RELAY_TTL_S);
    return html;
  } catch (err) {
    lastFailure = err instanceof Error ? err.message : String(err);
    return "";
  }
}

/**
 * REEA-1221 — reader-relay hop for LuLu Kuwait and Ounass. Its zone answers
 * every plain hop from our egress with Cloudflare's block page, and its list
 * page is server-rendered, so a reader relay that renders the page from ITS
 * egress returns exactly the HTML the lane's card scanner reads.
 *
 * Politeness: KV-cached per URL, a budgeted slot per call, a per-hop cooldown
 * after a rate-limit answer. Best-effort: any miss returns "" and the lane
 * keeps its existing degraded note.
 */
export async function jinaClearedHtml(
  url: string,
  /**
   * REEA-1235 — the signature that proves the relay returned the lane's OWN
   * page. Pass every shape that counts as an answer: a lane whose storefront
   * answers a query with "0 results found" ships no product rows at all, and
   * gating on the row selector alone rejected that page as "no page" — Nest's
   * 11-of-12 blocked panel settle (REEA-1229). Any listed marker matches.
   */
  marker: string | readonly string[],
): Promise<string> {
  if (!relayTierEnabled()) return "";
  const markers = (Array.isArray(marker) ? marker : [marker])
    .map((m) => m.replace(/^[.#]/, ""))
    .filter((m) => m !== "");
  const carries = (body: string): boolean => markers.some((m) => body.includes(m));
  const kv = getSharedKv();
  const key = `jina-cleared:${url}`;
  const cached = await readClearedBody(kv, key, carries);
  if (cached) return cached;
  // REEA-1242 — ONE provider budget for both reader modes: the 20/60 s quota is
  // per egress, not per mode, so counting each hop separately doubled the
  // allowed rate and the provider answered 429 (measured 2026-11-26 on the
  // 12-query panel).
  if (!(await acquireRelaySlot("jina", jinaLimits()))) return "";
  try {
    const res = await fetch(`${JINA_ENDPOINT}${url}`, {
      headers: jinaHeaders("html"),
      signal: AbortSignal.timeout(JINA_TIMEOUT_MS),
    });
    if (!res.ok) {
      lastFailure = `reader relay HTTP ${res.status}`;
      if (res.status === 429 || res.status === 503) {
        applyRelayCooldown("jina", retryAfterSeconds(res), jinaLimits().windowMs);
      }
      return "";
    }
    // REEA-1241 — bounded read: an oversized reader-relay answer degrades to
    // "" at the cap instead of being buffered whole.
    const html = await readCappedBody(res, RELAY_MAX_RESPONSE_BODY_BYTES, "reader relay");
    if (!carries(html)) {
      lastFailure = "reader relay answered without the lane's content selector";
      return "";
    }
    await cacheClearedBody(kv, key, html, RELAY_TTL_S);
    return html;
  } catch (err) {
    lastFailure = err instanceof Error ? err.message : String(err);
    return "";
  }
}

/**
 * REEA-1221 — the reader relay's MARKDOWN render. The same relay serves two
 * modes: `html` hands back the raw source (so a JS challenge is unsolved), while
 * `markdown` renders the page with a browser and carries the painted grid
 * (measured 2026-11-26 on Next Store: markdown 81 KB with ten priced rows vs
 * html 5.9 KB "Just a moment"). Lanes whose parser can read markdown use this
 * hop. It shares the reader tier's provider budget and cooldown with the html
 * hop (one quota per egress), and the meta-relay's budget is separate.
 */
const MARKDOWN_TTL_S = 30 * 60;

export async function relayMarkdown(url: string, marker: string): Promise<string> {
  if (!relayTierEnabled()) return "";
  const kv = getSharedKv();
  const key = `relay-md:${url}`;
  const cached = await readClearedBody(kv, key, (body) => body.includes(marker));
  if (cached) return cached;
  if (!(await acquireRelaySlot("jina", jinaLimits()))) return "";
  try {
    const res = await fetch(`${JINA_ENDPOINT}${url}`, {
      headers: jinaHeaders("markdown"),
      signal: AbortSignal.timeout(JINA_TIMEOUT_MS),
    });
    if (!res.ok) {
      lastFailure = `markdown relay HTTP ${res.status}`;
      if (res.status === 429 || res.status === 503) {
        applyRelayCooldown("jina", retryAfterSeconds(res), jinaLimits().windowMs);
      }
      return "";
    }
    // REEA-1241 — bounded read: an oversized markdown render degrades to "".
    const md = await readCappedBody(res, RELAY_MAX_RESPONSE_BODY_BYTES, "markdown relay");
    if (!md.includes(marker)) {
      lastFailure = "reader relay markdown carried no product rows";
      return "";
    }
    await cacheClearedBody(kv, key, md, MARKDOWN_TTL_S);
    return md;
  } catch (err) {
    lastFailure = err instanceof Error ? err.message : String(err);
    return "";
  }
}
