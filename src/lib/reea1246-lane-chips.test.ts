/**
 * REEA-1246 AC3 — the PDP lane rail is a retailer rail.
 *
 * Live defect: the runner fans out one scrape per retailer+SKU listing, so a
 * retailer with two listings rendered two chips ("Eureka, Eureka") and the
 * "n/m stores" line counted listings. These pins hold the fold to one chip per
 * retailer with the aggregate state, and keep the progress population equal to
 * the chips the shopper sees.
 */
import { describe, expect, it } from "vitest";
import { foldLaneChipsByRetailer } from "@/lib/lane-chips";
import type { RetailerSubtask } from "@/lib/collect/types";

function sub(overrides: Partial<RetailerSubtask>): RetailerSubtask {
  return {
    retailer: "Eureka",
    domain: "eureka.com.kw",
    status: "collecting",
    offersFound: 0,
    ...overrides,
  };
}

describe("REEA-1246 AC3 — one lane chip per retailer", () => {
  it("folds a retailer's duplicate listings into one chip", () => {
    const chips = foldLaneChipsByRetailer([
      sub({ retailer: "Eureka", status: "done", offersFound: 1 }),
      sub({ retailer: "Eureka", status: "done", offersFound: 2 }),
      sub({ retailer: "Wibi", status: "collecting" }),
    ]);
    expect(chips.map((c) => c.retailer)).toEqual(["Eureka", "Wibi"]);
    expect(chips[0]).toMatchObject({ status: "done", offersFound: 3, listings: 2 });
    expect(chips[1]).toMatchObject({ status: "collecting", listings: 1 });
  });

  it("case-folds the retailer identity (Xcite / xcite are one store)", () => {
    const chips = foldLaneChipsByRetailer([
      sub({ retailer: "Xcite", status: "done", offersFound: 1 }),
      sub({ retailer: "xcite", status: "done", offersFound: 1 }),
    ]);
    expect(chips).toHaveLength(1);
    expect(chips[0].offersFound).toBe(2);
  });

  it("keeps a retailer collecting while a sibling listing is still running", () => {
    const chips = foldLaneChipsByRetailer([
      sub({ retailer: "Eureka", status: "done", offersFound: 1 }),
      sub({ retailer: "Eureka", status: "collecting" }),
    ]);
    expect(chips[0].status).toBe("done");
  });

  it("reads failed only when every listing the retailer owns failed", () => {
    const chips = foldLaneChipsByRetailer([
      sub({ retailer: "Eureka", status: "failed", error: "HTTP 503" }),
      sub({ retailer: "Eureka", status: "timeout", error: "Exceeded 10s budget" }),
    ]);
    expect(chips).toHaveLength(1);
    expect(chips[0].status).toBe("failed");
    expect(chips[0].error).toBe("HTTP 503");
  });

  it("never renders an empty retailer chip", () => {
    expect(foldLaneChipsByRetailer([sub({ retailer: "  " })])).toEqual([]);
  });
});
