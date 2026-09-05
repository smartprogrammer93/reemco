import { describe, expect, it } from "vitest";
import { relativeAge } from "@/lib/relative-time";

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
