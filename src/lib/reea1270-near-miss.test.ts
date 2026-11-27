/**
 * REEA-1270 (Bet 3) — bounded near-miss correction for misspelled Latin
 * brand/model tokens.
 *
 * The guardrails this pins, in the order the ticket asks for them:
 *  - the measured near-miss panel resolves to the spelling the retailers
 *    actually answer (`iphon` → `iphone`, `samsng` → `samsung`, …);
 *  - a token that is already a canonical spelling is NEVER touched (no
 *    over-correction of a working query);
 *  - short tokens, model codes with digits, and Arabic-script tokens ride
 *    through untouched (Bet 8 owns Arabic);
 *  - the correction is bounded (≤2 tokens) and deterministic;
 *  - a token that is not a one-edit near miss of a curated brand/model word
 *    stays exactly as typed.
 */
import { describe, expect, it } from "vitest";
import {
  CANONICAL_LATIN_TOKENS,
  MAX_CORRECTIONS_PER_QUERY,
  boundedEditDistance,
  correctToken,
  nearMissCorrection,
} from "@/lib/near-miss";

describe("REEA-1270 R-1 — the measured near-miss panel resolves", () => {
  const panel: [string, string][] = [
    ["iphon 17 pro", "iphone 17 pro"],
    ["samsng s25", "samsung s25"],
    ["whirpool microwave", "whirlpool microwave"],
    ["reciever", "receiver"],
    ["nintindo switch 2", "nintendo switch 2"],
    ["dyson airwarp", "dyson airwrap"],
    ["samsung washing mashine", "samsung washing machine"],
  ];
  for (const [typed, corrected] of panel) {
    it(`corrects "${typed}" to "${corrected}"`, () => {
      const fix = nearMissCorrection(typed);
      expect(fix).not.toBeNull();
      expect(fix?.to).toBe(corrected);
      expect(fix?.from).toBe(typed);
    });
  }

  it("leaves a query whose tokens are all canonical untouched", () => {
    // The panel's already-answering rows: a correction here would re-spell a
    // working shelf for no reason.
    expect(nearMissCorrection("jbl tune 520bt")).toBeNull();
    expect(nearMissCorrection("xiaomi 15 pro")).toBeNull();
    expect(nearMissCorrection("iphone 17 pro")).toBeNull();
  });

  it("names the singular AirPods spelling only when it is a one-edit miss", () => {
    // "airpod" is not a canonical spelling; the dispatch path applies the
    // correction only on a zero answer, so a working "airpod pro" page is
    // never re-spelled.
    expect(nearMissCorrection("airpod pro")?.to).toBe("airpods pro");
  });
});

describe("REEA-1270 — bounded edit distance, deterministic resolution", () => {
  it("measures a single adjacent transposition as one edit", () => {
    expect(boundedEditDistance("reciever", "receiver")).toBe(1);
    expect(boundedEditDistance("iphon", "iphone")).toBe(1);
    expect(boundedEditDistance("mashine", "machine")).toBe(1);
    expect(boundedEditDistance("foldable", "fold")).toBeGreaterThan(1);
  });

  it("is deterministic for repeated calls", () => {
    expect(nearMissCorrection("iphon samsng")).toEqual(nearMissCorrection("iphon samsng"));
  });

  it("caps the number of corrected tokens per query", () => {
    const fix = nearMissCorrection("iphon samsng nintindo whirpool");
    expect(fix).not.toBeNull();
    expect(fix?.tokens).toHaveLength(MAX_CORRECTIONS_PER_QUERY);
    expect(fix?.to).toBe("iphone samsung nintindo whirpool");
  });
});

describe("REEA-1270 — no over-correction", () => {
  it("never re-spells a canonical token", () => {
    for (const token of ["iphone", "samsung", "note", "fold", "washing", "machine"]) {
      expect(correctToken(token)).toBeNull();
    }
  });

  it("leaves short tokens alone (one edit is too coarse)", () => {
    for (const token of ["pads", "ear", "pro", "tv", "hp", "lg"]) {
      expect(correctToken(token)).toBeNull();
    }
  });

  it("leaves model codes with digits alone (the code path owns them)", () => {
    expect(nearMissCorrection("wh1000xm6")).toBeNull();
    expect(nearMissCorrection("s25 ultra")).toBeNull();
    expect(nearMissCorrection("jbl tune 520bt")).toBeNull();
  });

  it("leaves Arabic-script tokens to the Bet 8 lexicon", () => {
    expect(nearMissCorrection("غسالة")).toBeNull();
    expect(nearMissCorrection("ثلاجة سامسونج")).toBeNull();
    // A mixed query still corrects its Latin typo and keeps the Arabic token.
    expect(nearMissCorrection("غسالة samsng")?.to).toBe("غسالة samsung");
  });

  it("leaves a word that is not a one-edit near miss exactly as typed", () => {
    expect(nearMissCorrection("kindle paperwhite cover")).toBeNull();
    expect(nearMissCorrection("apple pencil pro tips")).toBeNull();
    expect(nearMissCorrection("zzzzqqq")).toBeNull();
    expect(nearMissCorrection("xyzzy no such thing")).toBeNull();
  });

  it("ships a curated, finite vocabulary (no request-time catalogue scan)", () => {
    expect(CANONICAL_LATIN_TOKENS.has("iphone")).toBe(true);
    expect(CANONICAL_LATIN_TOKENS.has("samsung")).toBe(true);
    expect(CANONICAL_LATIN_TOKENS.has("whirlpool")).toBe(true);
    expect(CANONICAL_LATIN_TOKENS.has("receiver")).toBe(true);
    expect(CANONICAL_LATIN_TOKENS.has("airwrap")).toBe(true);
    expect(CANONICAL_LATIN_TOKENS.size).toBeLessThan(500);
  });
});
