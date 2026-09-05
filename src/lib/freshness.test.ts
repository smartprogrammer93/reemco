import { describe, expect, it } from "vitest";
import { freshness } from "@/lib/freshness";

// Fixed clock: 2026-09-12T12:00:00Z.
const NOW = Date.parse("2026-09-12T12:00:00Z");

describe("freshness (REEA-65 §4.1 buckets)", () => {
  it("returns null for missing metadata (render 'unknown', never fabricate)", () => {
    expect(freshness(undefined, NOW)).toBeNull();
    expect(freshness("", NOW)).toBeNull();
  });

  it("returns null for unparseable or future timestamps", () => {
    expect(freshness("not-a-date", NOW)).toBeNull();
    expect(freshness("2026-09-12T13:00:00Z", NOW)).toBeNull();
  });

  it("buckets <1h as 'minutes ago'", () => {
    expect(freshness("2026-09-12T11:20:00Z", NOW)).toEqual({
      label: "minutes ago",
      stale: false,
    });
  });

  it("buckets <24h in hours", () => {
    expect(freshness("2026-09-12T02:00:00Z", NOW)).toEqual({
      label: "10h ago",
      stale: false,
    });
  });

  it("buckets <7d in days, not stale", () => {
    expect(freshness("2026-09-08T12:00:00Z", NOW)).toEqual({
      label: "4d ago",
      stale: false,
    });
  });

  it("flags >7d as stale with day label", () => {
    expect(freshness("2026-09-03T12:00:00Z", NOW)).toEqual({
      label: "9d ago",
      stale: true,
    });
  });

  it("treats exactly 7d as the stale boundary (not stale)", () => {
    expect(freshness("2026-09-05T12:00:00Z", NOW)?.stale).toBe(false);
    expect(freshness("2026-09-05T11:59:00Z", NOW)?.stale).toBe(true);
  });
});
