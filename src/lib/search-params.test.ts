import { describe, it, expect } from "vitest";
import { sanitizeSearchQuery, sanitizePage } from "./search-params";

/** AC-U4 regression tests: malformed/oversized params degrade safely. */
describe("sanitizeSearchQuery (AC-U4)", () => {
  it("accepts normal queries", () => {
    expect(sanitizeSearchQuery("wireless mouse")).toBe("wireless mouse");
  });

  it("degrades malformed types to zero-result state (null)", () => {
    expect(sanitizeSearchQuery(null)).toBeNull();
    expect(sanitizeSearchQuery(undefined)).toBeNull();
    expect(sanitizeSearchQuery({ q: "x" })).toBeNull();
    expect(sanitizeSearchQuery("   ")).toBeNull();
  });

  it("strips control characters and collapses whitespace", () => {
    expect(sanitizeSearchQuery("a\u0000b\nc  d")).toBe("a b c d");
  });

  it("truncates oversized queries safely (codepoint-safe)", () => {
    const big = "x".repeat(5000);
    expect(sanitizeSearchQuery(big)!.length).toBe(200);
    const emoji = "😀".repeat(300);
    expect(Array.from(sanitizeSearchQuery(emoji)!).length).toBe(200);
  });
});

describe("sanitizePage (AC-U4)", () => {
  it("degrades malformed page values to 1", () => {
    expect(sanitizePage("abc")).toBe(1);
    expect(sanitizePage("-5")).toBe(1);
    expect(sanitizePage("1e12")).toBe(1);
    expect(sanitizePage("2.5")).toBe(1);
    expect(sanitizePage(null)).toBe(1);
  });
  it("accepts in-range integers", () => {
    expect(sanitizePage("3")).toBe(3);
    expect(sanitizePage(7)).toBe(7);
  });
});
