import { describe, expect, it } from "vitest";
import { absoluteStamp, relativeAge } from "@/lib/relative-time";

describe("relativeAge (plan AC4: collected Xs ago)", () => {
  const now = Date.parse("2026-09-05T21:00:00Z");

  it("renders sub-minute seconds during a live run", () => {
    expect(relativeAge("2026-09-05T20:59:52Z", now)).toBe("8s ago");
  });

  it("rolls to minutes and hours", () => {
    expect(relativeAge("2026-09-05T20:57:00Z", now)).toBe("3m ago");
    expect(relativeAge("2026-09-05T18:00:00Z", now)).toBe("3h ago");
    expect(relativeAge("2026-09-03T21:00:00Z", now)).toBe("2d ago");
  });

  it("returns null for missing, invalid, or future timestamps", () => {
    expect(relativeAge(undefined, now)).toBeNull();
    expect(relativeAge("not-a-date", now)).toBeNull();
    expect(relativeAge("2026-09-05T21:00:01Z", now)).toBeNull();
  });
});

describe("absoluteStamp (REEA-759: absolute timestamp in the detail view)", () => {
  it("formats minute-precision UTC with Latin digits, locale-invariant", () => {
    expect(absoluteStamp("2026-09-12T09:15:00Z")).toBe("2026-09-12 09:15 UTC");
    // Sub-minute precision is deliberately truncated, not rounded up.
    expect(absoluteStamp("2026-09-12T09:15:59Z")).toBe("2026-09-12 09:15 UTC");
    // Zero-padded month/day/hour/minute.
    expect(absoluteStamp("2026-01-02T03:04:05Z")).toBe("2026-01-02 03:04 UTC");
  });

  it("is pure — no clock read, so SSR and hydration agree (REEA-283)", () => {
    expect(absoluteStamp("2026-09-12T09:15:00Z")).toBe(absoluteStamp("2026-09-12T09:15:00Z"));
  });

  it("returns null for missing or invalid stamps — never fabricates a moment", () => {
    expect(absoluteStamp(undefined)).toBeNull();
    expect(absoluteStamp("not-a-date")).toBeNull();
    expect(absoluteStamp("")).toBeNull();
  });
});
