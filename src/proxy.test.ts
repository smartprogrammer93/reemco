/**
 * REEA-74 — CSP report sink regression tests (REEA-70 Stage 1).
 * REEA-1088 — nonce + 'strict-dynamic' policy and its propagation to the
 * render (the lane Next reads the nonce from).
 * (a) enforce policy script-src is nonce-only, with no host-source wildcard
 * (b) POST /api/csp-report with a well-formed report → 2xx
 * (c) malformed / oversized / GET → 4xx
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import {
  buildCsp,
  proxy,
  // REEA-1133 — per-IP page budget on the live fan-out addresses.
  PAGE_RATE_LIMIT,
  checkPageRateLimit,
  clientAddressOf,
  isLiveFanoutPage,
  resetPageRateLimiter,
} from "./proxy";
import {
  MAX_REPORT_BODY_BYTES,
  parseCspReport,
  recordViolation,
  recentViolations,
  resetViolations,
} from "./lib/csp-report";
import { resetRateLimiter } from "./lib/rate-limit";
// eslint-disable-next-line import/no-relative-packages
import { POST as cspReportPost } from "./app/api/csp-report/route";

/** Extract the script-src directive tokens from a policy. */
function scriptSrcOf(csp: string): string {
  return csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src")) ?? "";
}

function nonceOf(csp: string): string | undefined {
  return /'nonce-([A-Za-z0-9+/_-]+={0,2})'/.exec(csp)?.[1];
}

describe("REEA-74 Stage-1 enforce CSP policy", () => {
  it("script-src contains no https:/http: host-source wildcard", () => {
    const csp = buildCsp("abc123", "enforce");
    const scriptSrc = scriptSrcOf(csp);
    expect(scriptSrc).not.toBe("");
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toMatch(/(^|\s)https:(\s|$)/);
    expect(scriptSrc).not.toMatch(/(^|\s)http:(\s|$)/);
  });

  it("enforce header name is Content-Security-Policy and policy carries report-uri", () => {
    const csp = buildCsp("abc123", "enforce");
    expect(csp).toContain("report-uri /api/csp-report");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
  });
});

/**
 * REEA-1088 — F10: the REEA-82 static-page premise is gone (layout reads
 * cookies/headers; /results, /search and /product are force-dynamic), so the
 * header policy must be a real nonce policy again. These assertions fail on
 * 682f3db, where buildCsp shipped `script-src 'self' 'unsafe-inline'` and the
 * forwarded request never carried a nonce for Next to stamp onto its scripts.
 */
describe("REEA-1088 nonce + strict-dynamic CSP", () => {
  it("buildCsp('abc') carries nonce-abc and 'strict-dynamic' and no script 'unsafe-inline'", () => {
    const csp = buildCsp("abc", "enforce");
    const scriptSrc = scriptSrcOf(csp);
    expect(scriptSrc).toContain("'nonce-abc'");
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    // Styles stay inline-allowed: the theme renders style attributes.
    const styleSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("style-src")) ?? "";
    expect(styleSrc).toContain("'unsafe-inline'");
    // Production/test builds must not need eval.
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it("forwards the same nonce-bearing CSP on the REQUEST headers Next parses", () => {
    const res = proxy(new NextRequest("https://ns539626.ip-144-217-72.net/"));
    const servedCsp = res.headers.get("Content-Security-Policy") ?? "";
    const nonce = nonceOf(servedCsp);
    expect(nonce).toBeTruthy();
    // Next's app-render path (getScriptNonceFromHeaders) reads the REQUEST's
    // CSP header, not x-nonce, and stamps the framework/bootstrap scripts with
    // that nonce. Without this forwarded header every script is blocked under
    // 'strict-dynamic' and hydration never runs (the REEA-82 failure mode).
    const forwarded = res.headers.get("x-middleware-request-content-security-policy");
    expect(forwarded).toBe(servedCsp);
    expect(nonceOf(forwarded ?? "")).toBe(nonce);
    expect(res.headers.get("x-middleware-override-headers")).toContain("content-security-policy");
    // App-side channel for manual <Script nonce={...}> tags stays intact.
    expect(res.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
  });

  it("issues a fresh nonce per request", () => {
    const a = nonceOf(proxy(new NextRequest("https://ns539626.ip-144-217-72.net/")).headers.get("Content-Security-Policy") ?? "");
    const b = nonceOf(proxy(new NextRequest("https://ns539626.ip-144-217-72.net/")).headers.get("Content-Security-Policy") ?? "");
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toBe(b);
  });
});

const LEGACY_REPORT = {
  "csp-report": {
    "document-uri": "https://ns539626.ip-144-217-72.net/results?q=shoes",
    referrer: "",
    "violated-directive": "script-src-elem",
    "effective-directive": "script-src-elem",
    "original-policy": "default-src 'self'; script-src 'self'",
    "blocked-uri": "https://evil.example/x.js",
    "status-code": 200,
  },
};

const MODERN_REPORT = {
  type: "csp-violation",
  age: 12,
  url: "https://ns539626.ip-144-217-72.net/",
  body: {
    documentURL: "https://ns539626.ip-144-217-72.net/",
    effectiveDirective: "img-src",
    blockedURL: "https://tracker.example/pixel",
    statusCode: 0,
  },
};

function postReq(body: string, contentType: string): Request {
  return new Request("http://localhost/api/csp-report", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

describe("REEA-74 /api/csp-report sink", () => {
  beforeEach(() => {
    resetRateLimiter();
    resetViolations();
  });

  it("accepts a well-formed legacy report with 2xx", async () => {
    const res = await cspReportPost(
      postReq(JSON.stringify(LEGACY_REPORT), "application/csp-report") as never,
    );
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    expect(recentViolations()[0]?.directive).toBe("script-src-elem");
  });

  it("accepts the modern Reporting API shape", async () => {
    const res = await cspReportPost(
      postReq(JSON.stringify(MODERN_REPORT), "application/reports+json") as never,
    );
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });

  it("rejects malformed JSON and unrecognized shapes with 4xx", async () => {
    const bad = await cspReportPost(postReq("not json", "application/csp-report") as never);
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);

    const wrongShape = await cspReportPost(
      postReq(JSON.stringify({ hello: "world" }), "application/csp-report") as never,
    );
    expect(wrongShape.status).toBeGreaterThanOrEqual(400);
    expect(wrongShape.status).toBeLessThan(500);
  });

  it("rejects oversized bodies with 4xx", async () => {
    const big = JSON.stringify(LEGACY_REPORT).padEnd(MAX_REPORT_BODY_BYTES + 1, "x");
    const res = await cspReportPost(postReq(big, "application/csp-report") as never);
    expect(res.status).toBe(413);
  });

  it("rejects wrong content types with 4xx", async () => {
    const res = await cspReportPost(
      postReq(JSON.stringify(LEGACY_REPORT), "application/json") as never,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it("GET is not routed to POST (method not allowed by absence)", async () => {
    // The route only exports POST, so Next serves GET as 405; here we prove
    // the handler itself never accepts a GET-style empty payload path.
    const parsed = parseCspReport(null);
    expect(parsed).toBeNull();
  });

  it("ring buffer stays bounded and strips PII (origin only)", () => {
    const store: ReturnType<typeof recentViolations> = [];
    for (let i = 0; i < 250; i++) {
      recordViolation(
        {
          ts: new Date(i).toISOString(),
          format: "legacy",
          directive: "script-src",
          statusCode: 200,
          documentOrigin: "https://ns539626.ip-144-217-72.net",
          sourceFile: "https://evil.example/x.js",
        },
        store as never,
        200,
      );
    }
    expect(store.length).toBe(200);
    const view = recentViolations(5, store as never);
    expect(view.length).toBe(5);
    expect(JSON.stringify(view)).not.toContain("?q=shoes");
  });
});

describe("REEA-447 shared cache window + query forwarding on results addresses", () => {
  it("sets the bounded window pair together on the served /results response", () => {
    const res = proxy(new NextRequest("https://ns539626.ip-144-217-72.net/results?q=sony"));
    const cc = res.headers.get("Cache-Control") ?? "";
    expect(cc).toContain("s-maxage=");
    expect(cc).not.toContain("no-store");
    // Locale variants must never share a cache entry.
    expect(res.headers.get("Vary")).toContain("Accept-Language");
  });

  it("forwards the query text percent-encoded for the shell locale chain", () => {
    // NextResponse.next({request}) ships rewritten request headers to the
    // render as x-middleware-request-* — that is the lane the layout reads
    // `x-query-text` from on a cold GET (decoded in src/lib/i18n-server.ts).
    const req = new NextRequest(
      "https://ns539626.ip-144-217-72.net/results?q=" + encodeURIComponent("كيفيات"),
    );
    const res = proxy(req);
    const forwarded = res.headers.get("x-middleware-request-x-query-text");
    expect(forwarded).toBe(encodeURIComponent("كيفيات"));
    expect(decodeURIComponent(forwarded ?? "")).toBe("كيفيات");
    expect(res.headers.get("x-middleware-override-headers")).toContain("x-query-text");
  });

  it("keeps the hardening CSP on non-results paths without the window pair", () => {
    const res = proxy(new NextRequest("https://ns539626.ip-144-217-72.net/about"));
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    // The window belongs to the results addresses only (RESULTS_PATHS).
    expect(res.headers.get("Cache-Control") ?? "").toBe("");
  });
});


/**
 * REEA-1133 — F1 remediation of REEA-1121: the live fan-out pages must carry a
 * per-IP budget at the proxy so an unauthenticated burst of distinct queries is
 * answered 429 instead of each starting a ~15-lane retailer fan-out. These pins
 * fail on eba496ca, where 20 parallel /results renders answered 20×200.
 */
describe("REEA-1133 per-IP page budget on live fan-out addresses", () => {
  const BASE = "https://ns539626.ip-144-217-72.net";

  /** One request from `ip` as our own Caddy hop would present it. */
  function reqFrom(path: string, ip: string): NextRequest {
    return new NextRequest(BASE + path, { headers: { "x-forwarded-for": ip } });
  }

  beforeEach(() => {
    resetPageRateLimiter();
  });
  afterEach(() => {
    resetPageRateLimiter();
  });

  it("covers exactly the addresses that run the live retailer fan-out", () => {
    expect(isLiveFanoutPage("/results")).toBe(true);
    expect(isLiveFanoutPage("/search")).toBe(true);
    expect(isLiveFanoutPage("/product")).toBe(true);
    expect(isLiveFanoutPage("/product/abc123")).toBe(true);
    // No fan-out behind these: the budget must not throttle them.
    expect(isLiveFanoutPage("/")).toBe(false);
    expect(isLiveFanoutPage("/about")).toBe(false);
    expect(isLiveFanoutPage("/api/health")).toBe(false);
    expect(isLiveFanoutPage("/api/results-followup")).toBe(false);
  });

  it("answers 429 with Retry-After once a client exceeds the page budget", () => {
    const ip = "198.51.100.10";
    for (let i = 0; i < PAGE_RATE_LIMIT.limit; i += 1) {
      const res = proxy(reqFrom("/results?q=query-" + i, ip));
      expect(res.status).toBe(200);
      expect(res.headers.get("X-RateLimit-Remaining")).toBe(
        String(PAGE_RATE_LIMIT.limit - i - 1),
      );
    }
    // Request N+1 never starts a render (and therefore never fans out).
    const limited = proxy(reqFrom("/results?q=query-over", ip));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(limited.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(limited.headers.get("Cache-Control")).toContain("no-store");
    // The limited response still carries the hardening policy.
    expect(limited.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    expect(limited.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("budgets per client address: one exhausted IP does not throttle another", () => {
    const noisy = "198.51.100.11";
    for (let i = 0; i < PAGE_RATE_LIMIT.limit; i += 1) proxy(reqFrom("/results", noisy));
    expect(proxy(reqFrom("/results", noisy)).status).toBe(429);
    // A different shopper keeps their own bucket.
    expect(proxy(reqFrom("/results", "198.51.100.12")).status).toBe(200);
  });

  it("keys on the edge-observed hop, not the client-supplied first entry", () => {
    const peer = "198.51.100.13";
    for (let i = 0; i < PAGE_RATE_LIMIT.limit; i += 1) proxy(reqFrom("/product/x", peer));
    // Caddy APPENDS the peer, so the LAST hop is ours; the first is spoofable.
    // A fresh spoofed prefix must not buy a new budget.
    const spoofed = new NextRequest(BASE + "/product/x", {
      headers: { "x-forwarded-for": "10.9.9.9, " + peer },
    });
    expect(clientAddressOf(spoofed)).toBe(peer);
    expect(proxy(spoofed).status).toBe(429);
  });

  it("does not throttle non-fan-out paths from the same exhausted IP", () => {
    const ip = "198.51.100.14";
    for (let i = 0; i < PAGE_RATE_LIMIT.limit; i += 1) proxy(reqFrom("/results", ip));
    expect(proxy(reqFrom("/results", ip)).status).toBe(429);
    expect(proxy(reqFrom("/", ip)).status).toBe(200);
    expect(proxy(reqFrom("/api/health", ip)).status).toBe(200);
  });

  it("checkPageRateLimit refuses over the window and reports the wait", () => {
    const store = new Map<string, number[]>();
    const opts = { limit: 2, windowMs: 1000 };
    expect(checkPageRateLimit("k", 0, opts, store).allowed).toBe(true);
    expect(checkPageRateLimit("k", 1, opts, store).allowed).toBe(true);
    const denied = checkPageRateLimit("k", 2, opts, store);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(998); // oldest hit at t=0 + window - now
    // Window rolls forward: the oldest hit expires and capacity returns.
    expect(checkPageRateLimit("k", 1001, opts, store).allowed).toBe(true);
  });
});
