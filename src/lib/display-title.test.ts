/**
 * REEA-836 — display-side title hygiene pins. Every case below is a live
 * marketplace title shape (REEA-830 probe evidence) or a clean-title
 * regression guard (AC6). The transform is pure and presentation-only.
 */
import { describe, expect, it } from "vitest";
import { cleanDisplayTitle, displayTitleChanged } from "@/lib/display-title";

describe("REEA-836 — cleanDisplayTitle", () => {
  it("strips the live-probe boilerplate chain and keeps brand + model + storage (AC1/AC2)", () => {
    const raw =
      'Apple iPhone 17 Pro 6.3-inch A3256 | Tax Paid But "eSIM Only" eSIM + eSIM (8 or more, max 2 at a time) Unlocked, 512GB';
    const cleaned = cleanDisplayTitle(raw);
    expect(cleaned).toBe("Apple iPhone 17 Pro 6.3-inch A3256 512GB");
    expect(cleaned).not.toContain("Tax Paid");
    expect(cleaned).not.toContain("8 or more");
    expect(cleaned).not.toContain("max 2 at a time");
    expect(cleaned).not.toContain("|");
    expect(cleaned).toContain("512GB");
  });

  it("drops promo tail clauses and keeps identity tail clauses", () => {
    expect(cleanDisplayTitle("iPhone 17 Pro | Tax Paid | 2 Years Official Warranty")).toBe(
      "iPhone 17 Pro",
    );
    expect(cleanDisplayTitle("Sony WH-1000XM5 | Black")).toBe("Sony WH-1000XM5 Black");
  });

  it("removes quantity-promo parentheticals but keeps capacity parentheticals", () => {
    expect(cleanDisplayTitle("iPhone 17 Pro (8 or more, max 2 at a time) 256GB")).toBe(
      "iPhone 17 Pro 256GB",
    );
    expect(cleanDisplayTitle("Galaxy S25 (256 GB) Black")).toBe("Galaxy S25 (256 GB) Black");
  });

  it("reattaches storage stranded in a dropped clause only when the head lacks it", () => {
    expect(cleanDisplayTitle("Apple iPhone 17 Pro | Unlocked, 512GB")).toBe(
      "Apple iPhone 17 Pro 512GB",
    );
    // Head already carries the tier — no duplication.
    expect(cleanDisplayTitle("Apple iPhone 17 Pro 256GB | Unlocked, 256GB")).toBe(
      "Apple iPhone 17 Pro 256GB",
    );
  });

  it("leaves clean titles byte-identical (AC6)", () => {
    expect(cleanDisplayTitle("Apple iPhone 17 Pro (256 GB) - Silver")).toBe(
      "Apple iPhone 17 Pro (256 GB) - Silver",
    );
    expect(cleanDisplayTitle("Samsung Galaxy S25 Ultra 512GB Titanium")).toBe(
      "Samsung Galaxy S25 Ultra 512GB Titanium",
    );
    expect(cleanDisplayTitle("Xiaomi Redmi Note 13 4G 128GB")).toBe(
      "Xiaomi Redmi Note 13 4G 128GB",
    );
  });

  it("cleans Arabic boilerplate clauses with the same rules (AC5)", () => {
    expect(cleanDisplayTitle("آيفون 17 برو 256 جيجا | ضمان سنتين")).toBe("آيفون 17 برو 256 جيجا");
    expect(cleanDisplayTitle("آيفون 17 برو | ضريبة مدفوعة | هدية")).toBe("آيفون 17 برو");
  });

  it("returns the raw string untouched for empty or single-clause clean input", () => {
    expect(cleanDisplayTitle("")).toBe("");
    expect(cleanDisplayTitle("Pixel 8 Pro")).toBe("Pixel 8 Pro");
  });

  it("recovers a title when every clause scrubs away", () => {
    expect(cleanDisplayTitle("Tax Paid")).toBe("Tax Paid");
  });
});

describe("REEA-836 — displayTitleChanged (AC3 affordance gate)", () => {
  it("is false for whitespace-only differences", () => {
    expect(displayTitleChanged("Pixel 8 Pro", "Pixel 8 Pro")).toBe(false);
    expect(displayTitleChanged("  Pixel  8  Pro  ", "Pixel 8 Pro")).toBe(false);
  });

  it("is true when boilerplate was stripped", () => {
    expect(displayTitleChanged("iPhone 17 Pro | Tax Paid", "iPhone 17 Pro")).toBe(true);
  });
});
