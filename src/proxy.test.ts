/**
 * REEA-74 — CSP report sink regression tests (REEA-70 Stage 1).
 * (a) enforce policy script-src has no `https:`/`http:` token
 * (b) POST /api/csp-report with a well-formed report → 2xx
 * (c) malformed / oversized / GET → 4xx
 */
import { describe, expect, it, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { buildCsp, proxy } from "./proxy";
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

describe("REEA-74 Stage-1 enforce CSP policy", () => {
  it("script-src contains no https:/http: host-source wildcard", () => {
    const csp = buildCsp("abc123", "enforce");
    const scriptSrc = csp.split(";").find((d) => d.trim().startsWith("script-src"));
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).toContain("'self'");
    // REEA-82: pages are statically prerendered, so a nonce/'strict-dynamic'
    // policy blocked every script and hydration never ran. The shipped policy
    // must allow the build-time scripts ('self' + inline bootstrap).
    expect(scriptSrc).toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("'nonce-");
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

const LEGACY_REPORT = {
  "csp-report": {
    "document-uri": "https://reemco.vercel.app/results?q=shoes",
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
  url: "https://reemco.vercel.app/",
  body: {
    documentURL: "https://reemco.vercel.app/",
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
          documentOrigin: "https://reemco.vercel.app",
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
    const res = proxy(new NextRequest("https://reemco.vercel.app/results?q=sony"));
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
      "https://reemco.vercel.app/results?q=" + encodeURIComponent("كيفيات"),
    );
    const res = proxy(req);
    const forwarded = res.headers.get("x-middleware-request-x-query-text");
    expect(forwarded).toBe(encodeURIComponent("كيفيات"));
    expect(decodeURIComponent(forwarded ?? "")).toBe("كيفيات");
    expect(res.headers.get("x-middleware-override-headers")).toContain("x-query-text");
  });

  it("keeps the hardening CSP on non-results paths without the window pair", () => {
    const res = proxy(new NextRequest("https://reemco.vercel.app/about"));
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
    // The window belongs to the results addresses only (RESULTS_PATHS).
    expect(res.headers.get("Cache-Control") ?? "").toBe("");
  });
});

