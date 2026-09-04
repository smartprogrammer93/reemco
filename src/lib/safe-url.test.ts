import { describe, it, expect } from "vitest";
import {
  assertSafeExternalUrl,
  sanitizeExternalUrl,
  safeHref,
  InvalidExternalUrlError,
} from "./safe-url";

/**
 * REEA-13 F1 regression tests.
 * These fail on the old code path (`href={offer.url}` with no validation):
 * every malicious payload below would previously be persisted and rendered.
 */
describe("assertSafeExternalUrl (F1)", () => {
  const malicious: Array<[string, string]> = [
    ["javascript:alert(1)", "scheme not allowed"],
    ["JaVaScRiPt:alert(1)", "scheme not allowed"],
    [" javascript:alert(1)", "scheme not allowed"],
    ["java\tscript:alert(1)", "unparseable URL"], // tab is a control char -> rejected before parse
    ["data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==", "scheme not allowed"],
    ["vbscript:msgbox(1)", "scheme not allowed"],
    ["file:///etc/passwd", "scheme not allowed"],
    ["https://a@b@evil.com/p", "userinfo in URL"],
    ["https://user:pass@evil.com/p", "userinfo in URL"],
    ["https://evil.com/p\u0000", "control characters"],
    ["https://evil.com/\nalert(1)", "control characters"],
  ];

  it.each(malicious)("rejects %s", (input) => {
    expect(() => assertSafeExternalUrl(input)).toThrow(InvalidExternalUrlError);
    expect(sanitizeExternalUrl(input)).toBeNull();
    expect(safeHref(input)).toBeNull();
  });

  it("rejects protocol-relative URLs (//evil.com) — no scheme, fails closed", () => {
    expect(() => assertSafeExternalUrl("//evil.com")).toThrow(InvalidExternalUrlError);
    expect(sanitizeExternalUrl("//evil.com")).toBeNull();
  });

  it("rejects over-long URLs (>2048)", () => {
    const long = "https://evil.com/?q=" + "a".repeat(2100);
    expect(sanitizeExternalUrl(long)).toBeNull();
  });

  it("rejects non-string / empty input", () => {
    expect(sanitizeExternalUrl(null)).toBeNull();
    expect(sanitizeExternalUrl(undefined)).toBeNull();
    expect(sanitizeExternalUrl("")).toBeNull();
    expect(sanitizeExternalUrl({ url: "https://x.com" })).toBeNull();
  });

  it("accepts legitimate product URLs", () => {
    const good = "https://good.example/p?sku=123&ref=affiliate";
    expect(sanitizeExternalUrl(good)).toBe(good);
    expect(sanitizeExternalUrl("http://good.example/p")).toBe("http://good.example/p");
    // canonicalizes unicode-y host forms consistently
    expect(sanitizeExternalUrl("https://good.example/p")).toEqual(
      expect.stringContaining("https://good.example/p"),
    );
  });
});
