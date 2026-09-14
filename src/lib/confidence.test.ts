/**
 * REEA-964 R2 — confidence ladder unit pins. The threshold is ONE config
 * value (spec §4/§5); calibration must keep the AC-1/AC-2 live shapes
 * honest: flagship device queries put the device in primary and its cases in
 * the capped related band, nonsense queries score nothing at all.
 */
import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_THRESHOLD,
  RELATED_CAP,
  isAccessoryQuery,
  matchConfidence,
  partitionByConfidence,
} from "@/lib/confidence";

describe("threshold config (spec: one configuration value)", () => {
  it("exposes exactly one threshold and the FR-2.2 cap of 6", () => {
    expect(CONFIDENCE_THRESHOLD).toBe(2);
    expect(RELATED_CAP).toBe(6);
  });
});

describe("matchConfidence", () => {
  it("full token coverage is confident (primary)", () => {
    expect(matchConfidence("iPhone 17 Pro", "Apple iPhone 17 Pro 256GB")).toBe(
      CONFIDENCE_THRESHOLD,
    );
    expect(matchConfidence("iphone 17 pro", "iPhone 17 Pro Max 1TB")).toBe(
      CONFIDENCE_THRESHOLD,
    );
  });

  it("a case under a device query demotes to related, never primary (AC-2)", () => {
    expect(matchConfidence("iPhone 17 Pro", "iPhone 17 Pro Case Silicone Clear")).toBe(1);
    expect(matchConfidence("iPhone 17 Pro", "NILLKIN Case for iPhone 17 Pro")).toBe(1);
    expect(
      matchConfidence("iPhone 17 Pro", "iPhone 17 Pro Case Silicone Clear"),
    ).toBeLessThan(CONFIDENCE_THRESHOLD);
  });

  it("an accessory query keeps accessory titles confident", () => {
    expect(isAccessoryQuery("iphone 17 pro case")).toBe(true);
    expect(
      matchConfidence("iphone 17 pro case", "iPhone 17 Pro Case Silicone Clear"),
    ).toBe(CONFIDENCE_THRESHOLD);
  });

  it("exact-SKU queries keep the code-carrying row confident (REEA-822 interop)", () => {
    expect(
      matchConfidence(
        "EF-PS931CBEGWW",
        "Samsung Galaxy S25 Silicone Case, EF-PS931CBEGWW – Black",
      ),
    ).toBe(CONFIDENCE_THRESHOLD);
  });

  it("tier-3 partial coverage stays primary; metadata-only (tier 4) falls to the band", () => {
    // Half the tokens whole-word ("sony" ✓, "xm6" only inside "WH-1000XM6")
    // is still the queried product — primary.
    expect(matchConfidence("sony xm6", "Sony WH-1000XM6")).toBe(CONFIDENCE_THRESHOLD);
    // Metadata-only: the title itself never named the query → related.
    expect(
      matchConfidence("zzzqq iphone", "Apple Pro Handset", "iphone family shelf"),
    ).toBe(1);
  });

  it("nonsense queries score 0 — rendered nowhere (AC-1)", () => {
    expect(matchConfidence("zzqqxx nonexistent gadget", "LED Diffuser Light Strip")).toBe(0);
    expect(matchConfidence("zzqqxx nonexistent gadget", "Stage Light Par 54 RGB")).toBe(0);
  });

  it("empty query keeps the all-products browse confident (tier 1 by contract)", () => {
    expect(matchConfidence("", "Anything At All")).toBe(CONFIDENCE_THRESHOLD);
  });
});

describe("partitionByConfidence", () => {
  const PHONE = { title: "Apple iPhone 17 Pro 256GB", id: "p1" };
  const PHONE_MAX = { title: "iPhone 17 Pro Max 1TB", id: "p2" };
  const CASE = { title: "iPhone 17 Pro Case Silicone", id: "c1" };
  const CASE2 = { title: "Clear Cover for iPhone 17 Pro", id: "c2" };

  it("splits iPhone 17 Pro: phones primary, cases related (AC-2)", () => {
    const { primary, related } = partitionByConfidence("iPhone 17 Pro", [
      CASE,
      PHONE,
      CASE2,
      PHONE_MAX,
    ]);
    expect(primary.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(related.map((p) => p.id)).toEqual(["c1", "c2"]);
  });

  it("caps the related band at 6 (AC-3) and keeps primary order", () => {
    const rows = [
      PHONE,
      ...Array.from({ length: 9 }, (_, i) => ({ title: `iPhone 17 Pro Case ${i}`, id: `c${i}` })),
    ];
    const { primary, related } = partitionByConfidence("iPhone 17 Pro", rows);
    expect(primary).toEqual([PHONE]);
    expect(related).toHaveLength(6);
  });

  it("drops tier-0 rows entirely — nonsense query renders empty sections (AC-1)", () => {
    const rows = [PHONE, CASE, { title: "LED Diffuser Light Strip", id: "d1" }];
    const { primary, related } = partitionByConfidence("zzqqxx nonexistent gadget", rows);
    expect(primary).toEqual([]);
    expect(related).toEqual([]);
  });

  it("accessory-only match set: empty primary + related band (AC-4 / E3)", () => {
    const { primary, related } = partitionByConfidence("iPhone 17 Pro", [CASE, CASE2]);
    expect(primary).toEqual([]);
    expect(related.map((p) => p.id)).toEqual(["c1", "c2"]);
  });

  it("single confident match, no related: E2 shape", () => {
    const { primary, related } = partitionByConfidence("iPhone 17 Pro", [PHONE]);
    expect(primary).toEqual([PHONE]);
    expect(related).toEqual([]);
  });

  it("Arabic device query keeps Arabic titles confident (E4 parity)", () => {
    expect(matchConfidence("آيفون 17 برو", "آيفون 17 برو 256 جيجا")).toBe(
      CONFIDENCE_THRESHOLD,
    );
  });
});
