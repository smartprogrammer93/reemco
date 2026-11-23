import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { FRESH_CHIP_ALT_RE, FRESH_CHIP_RE } from "./freshness-chip";
import { fill, getStrings } from "./i18n";

// REEA-1092 — /api/health is a blocking deploy gate. Its freshness assertion
// went stale against REEA-1069 AC10 ("Updated just now"), so a healthy Shelf
// build answered 503 and rolled itself back (deploy run 45125867791). This pin
// asserts the matcher against the copy FreshnessBadge actually renders, and
// keeps the duplicate literal in scripts/smoke-check.mjs step 4 in sync.
const en = getStrings("en");

function renderedChip(mins: number): string {
  const label =
    mins === 0
      ? en.freshJustNow
      : mins === 1
        ? en.freshUpdatedMinute
        : fill(en.freshUpdatedMinutes, { n: mins });
  return `<span class="fresh-chip"><span class="fresh-dot" aria-hidden></span>${label}</span>`;
}

describe("REEA-1092 freshness-chip matcher", () => {
  it("matches every age the Shelf UI can render, including just now", () => {
    for (const mins of [0, 1, 4, 59, 120]) {
      const html = renderedChip(mins);
      expect(new RegExp(FRESH_CHIP_RE, "i").test(html), html).toBe(true);
    }
    // Legacy spellings stay accepted so an older artifact never false-fails.
    expect(new RegExp(FRESH_CHIP_RE, "i").test("Verified 2d ago")).toBe(true);
    expect(new RegExp(FRESH_CHIP_RE, "i").test("updated <!-- -->minutes ago")).toBe(true);
  });

  it("matches the stale and unknown badges", () => {
    expect(new RegExp(FRESH_CHIP_ALT_RE, "i").test(en.staleSuffix)).toBe(true);
    expect(new RegExp(FRESH_CHIP_ALT_RE, "i").test(en.freshUnknown)).toBe(true);
  });

  it("keeps scripts/smoke-check.mjs step 4 in sync with the probe", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const smoke = readFileSync(path.join(repoRoot, "scripts", "smoke-check.mjs"), "utf8");
    const match = smoke.match(/const chip = ("(?:[^"\\]|\\.)*");/);
    expect(match, "smoke-check.mjs step 4 chip literal not found").not.toBeNull();
    expect(JSON.parse(match![1])).toBe(FRESH_CHIP_RE);
  });
});
