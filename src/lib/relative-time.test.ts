import { describe, expect, it } from "vitest";
import {
  absoluteStamp,
  localizedAgeFor,
  localizedAgeFromStamp,
  localizedAgePair,
  localizedUpdatedFor,
  relativeAge,
} from "@/lib/relative-time";

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

describe("localizedAgePair (REEA-1070 AC10: locale-ready collection timestamps)", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");

  it("sub-minute reads just now / الآن, never a preformatted 0s ago", () => {
    expect(localizedAgePair(now - 12_000, now)).toEqual({ en: "just now", ar: "الآن" });
    expect(localizedAgeFor("en", now - 45_000, now)).toBe("just now");
    expect(localizedAgeFor("ar", now - 45_000, now)).toBe("الآن");
  });

  it("minutes use the design's EN ladder and Arabic dual/plural forms", () => {
    expect(localizedAgePair(now - 4 * 60_000, now)).toEqual({
      en: "4 min ago",
      ar: "قبل 4 دقائق",
    });
    expect(localizedAgePair(now - 2 * 60_000, now)).toEqual({
      en: "2 min ago",
      ar: "قبل دقيقتين",
    });
    expect(localizedAgePair(now - 60_000, now)).toEqual({
      en: "1 min ago",
      ar: "قبل دقيقة",
    });
    expect(localizedAgePair(now - 26 * 60_000, now)).toEqual({
      en: "26 min ago",
      ar: "قبل 26 دقيقة",
    });
    expect(localizedAgePair(now - 11 * 60_000, now).ar).toBe("قبل 11 دقيقة");
  });

  it("hours and days keep the same localized ladder", () => {
    expect(localizedAgePair(now - 2 * 3_600_000, now)).toEqual({
      en: "2 hr ago",
      ar: "قبل ساعتين",
    });
    expect(localizedAgePair(now - 2 * 86_400_000, now)).toEqual({
      en: "2 days ago",
      ar: "قبل يومين",
    });
  });

  it("composes the updated sentence the design pack asks for", () => {
    expect(localizedUpdatedFor("en", now - 4 * 60_000, now)).toBe("updated 4 min ago");
    expect(localizedUpdatedFor("ar", now - 2 * 60_000, now)).toBe("حُدِّث قبل دقيقتين");
    expect(localizedUpdatedFor("ar", now - 10_000, now)).toBe("حُدِّث الآن");
  });

  it("clamps a future stamp to just now rather than fabricating a negative age", () => {
    expect(localizedAgePair(now + 5_000, now)).toEqual({ en: "just now", ar: "الآن" });
  });

  it("returns an honest unknown for a non-finite epoch", () => {
    expect(localizedAgePair(Number.NaN, now)).toEqual({
      en: "unknown",
      ar: "وقت غير معروف",
    });
  });
});

describe("localizedAgeFromStamp (REEA-1095 AC10/AC11: provenance note)", () => {
  const now = Date.parse("2026-11-23T12:00:00Z");

  it("humanises a sub-minute ISO stamp as just now / الآن, never 0s ago", () => {
    expect(localizedAgeFromStamp("en", "2026-11-23T11:59:52Z", now)).toBe("just now");
    expect(localizedAgeFromStamp("ar", "2026-11-23T11:59:52Z", now)).toBe("الآن");
  });

  it("localises minute ages without splicing an English suffix onto Arabic", () => {
    expect(localizedAgeFromStamp("en", "2026-11-23T11:56:00Z", now)).toBe("4 min ago");
    expect(localizedAgeFromStamp("ar", "2026-11-23T11:56:00Z", now)).toBe("قبل 4 دقائق");
    expect(localizedAgeFromStamp("ar", "2026-11-23T11:58:00Z", now)).toBe("قبل دقيقتين");
  });

  it("returns null for missing or invalid stamps so the caller can say unknown", () => {
    expect(localizedAgeFromStamp("en", undefined, now)).toBeNull();
    expect(localizedAgeFromStamp("en", "not-a-date", now)).toBeNull();
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
