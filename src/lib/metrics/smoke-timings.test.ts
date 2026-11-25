/**
 * REEA-1166 — pins for the time-to-first-offer matcher in
 * scripts/smoke-timings.mjs. The REEA-1069 Shelf UI renders real result cards
 * as `<article class="rc-card result-card ...">`; the old matcher required
 * `result-card` to be the first class token, so a healthy production host
 * reported "TIMINGS skipped — 20/20 query probe(s) failed". These pins keep
 * the matcher aligned with the served markup and keep skeletons out.
 */
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const timings: any = await import("../../../scripts/smoke-timings.mjs");

describe("REEA-1166 hasFirstOfferCard", () => {
  it("matches the served Shelf markup (result-card is not the first class token)", () => {
    expect(
      timings.hasFirstOfferCard(
        '<div><article class="rc-card result-card min-w-0 pulse-cascade" style="--cascade-index:0"><div>',
      ),
    ).toBe(true);
  });

  it("still matches the legacy bare markup", () => {
    expect(timings.hasFirstOfferCard('<article class="result-card"><div>')).toBe(true);
  });

  it("rejects aria-hidden skeletons and unrelated articles", () => {
    expect(
      timings.hasFirstOfferCard('<article class="rc-card result-card" aria-hidden="true">'),
    ).toBe(false);
    expect(timings.hasFirstOfferCard('<article class="skeleton-card" aria-hidden="true">')).toBe(
      false,
    );
    expect(timings.hasFirstOfferCard('<article class="promo-banner">')).toBe(false);
    expect(timings.hasFirstOfferCard("")).toBe(false);
  });

  it("does not match a result-card in ordinary text", () => {
    expect(timings.hasFirstOfferCard('<p class="note">result-card</p>')).toBe(false);
  });
});
