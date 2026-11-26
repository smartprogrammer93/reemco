import { afterEach, describe, expect, it } from "vitest";
import {
  classifyClearanceBody,
  jinaHeaders,
  jinaLimits,
  relayWaitMs,
} from "@/lib/collect/browser-clearance";

/**
 * REEA-1242 — clearance-path guardrails. Each case pins one measured cause the
 * ticket diagnosed on the production egress, so the same drift cannot silently
 * return a blocked lane again.
 */
describe("REEA-1242 clearance path", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("names Cloudflare's WAF refusal as a block, not a solvable challenge", () => {
    // Measured 2026-11-26 from the production egress: every identity shape
    // (verified-crawler, browser-shaped, bare) earns this page on Next Store,
    // and it carries no challenge script — waiting on it burns the content
    // window for nothing.
    expect(
      classifyClearanceBody(
        '<html><head><title>Attention Required! | Cloudflare</title></head>' +
          '<body><div id="cf-error-details"><h1>Sorry, you have been blocked</h1></div></body></html>',
      ),
    ).toBe("block");
    expect(classifyClearanceBody("")).toBe("block");
  });

  it("names the managed challenge as a challenge, so the browser keeps waiting", () => {
    expect(
      classifyClearanceBody(
        '<html><head><title>Just a moment...</title></head><body>' +
          '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>',
      ),
    ).toBe("challenge");
  });

  it("passes a real storefront body through", () => {
    // Measured live 2026-11-26: the cleared LuLu list page (933 KB) carries
    // these cards and none of the shell markers.
    expect(
      classifyClearanceBody(
        '<html><head><title>laptop | LuLu Kuwait</title></head>' +
          '<body><app-product-card>laptop</app-product-card></body></html>',
      ),
    ).toBe("");
  });

  it("does not mistake a cleared page's bot-management script for a challenge", () => {
    // Measured 2026-11-26: the browser-painted LuLu list page (908 KB) carries
    // `/cdn-cgi/challenge-platform/...` scripts. Matching that string rejected
    // the very page the tier had just cleared, so the marker set is the shell's
    // own words only.
    expect(
      classifyClearanceBody(
        '<html><head><title>laptop | LuLu Kuwait</title>' +
          '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>' +
          "</head><body><app-product-card>laptop</app-product-card></body></html>",
      ),
    ).toBe("");
  });

  it("paces a relay at its published window instead of bursting into a 429", () => {
    const limits = { limit: 20, windowMs: 60_000 };
    const now = 1_000_000;
    // A full window of calls: the next one waits until the oldest ages out
    // (oldest is 59 s old, so 1 s remains before a slot frees).
    const hits = Array.from({ length: 20 }, (_, i) => now - 59_000 + i * 100);
    expect(relayWaitMs(hits, now, limits)).toBe(1_000);
    // Under the limit answers immediately.
    expect(relayWaitMs(hits.slice(0, 19), now, limits)).toBe(0);
    // Calls older than the window do not count.
    expect(relayWaitMs(hits.map((t) => t - 120_000), now, limits)).toBe(0);
    // An unlimited budget never waits.
    expect(relayWaitMs(hits, now, { limit: 0, windowMs: 60_000 })).toBe(0);
  });

  it("lifts the reader tier's ceiling when a paid key is configured", () => {
    delete process.env.JINA_API_KEY;
    delete process.env.JINA_RPM;
    expect(jinaLimits()).toEqual({ limit: 20, windowMs: 60_000 });
    process.env.JINA_API_KEY = "test-key";
    expect(jinaLimits()).toEqual({ limit: 200, windowMs: 60_000 });
    process.env.JINA_RPM = "500";
    expect(jinaLimits()).toEqual({ limit: 500, windowMs: 60_000 });
  });

  it("sends the key as an Authorization header and never as a query string", () => {
    delete process.env.JINA_API_KEY;
    const anon = jinaHeaders("html");
    expect(anon.authorization).toBeUndefined();
    expect(anon["x-respond-with"]).toBe("html");
    process.env.JINA_API_KEY = "secret-value";
    expect(jinaHeaders("markdown")).toMatchObject({
      authorization: "Bearer secret-value",
      "x-respond-with": "markdown",
    });
  });
});
