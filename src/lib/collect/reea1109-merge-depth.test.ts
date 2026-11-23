/**
 * REEA-1109 — comparison depth: the merge pass must fold the same SKU across
 * retailers when the retailer titles differ only by an official colour name,
 * a device-class descriptor, or a connector spec restatement.
 *
 * Live defect (deployed 9c66a12, W48 panel): card-level depth was 23/110
 * (~21%) and four queries carried zero multi-retailer cards. The split was
 * NOT a lane failure — the same product was live on two retailers and landed
 * on two separate single-retailer cards because an unrecognized colour word
 * or an appliance/spec descriptor stayed in the canonical MODEL LINE:
 *
 *  - `dyson`: Eureka's "Dyson Supersonic Nural Hair Dryer HD16 Apricot
 *    Topaz"/"… Blue Rich"/"… Amber silk" and Zayoom's "… Hd16 - Ceramic
 *    Pink" are one HD16 model in four colours → four single cards, 0 depth.
 *  - `ps5`: "Sony PS5 DualSense Wireless Controller Chroma Teal"/"Chroma
 *    Pearl" (Eureka, Wibi) and "… Galactic Purple" (Astore) are one
 *    controller → three single cards beside the already-merged base card.
 *  - `headphones`: "JBL Tune 500 On-Ear Headphones, … 3.5 mm Connector,
 *    In-line Microphone" (Jarir) and "JBL Tune 500 On Ear Headphones"
 *    (Danube Home) are one SKU → two single cards.
 *  - `fold 7`: Xcite's "… Z Fold7 5G 512Phone" is the 512 GB tier spelled
 *    glued to the device word → a separate card beside the 512 GB merge.
 *
 * Every title below is a live retailer spelling from that run; the merge is
 * query-time aggregation over fetched titles only — no alias table, no
 * catalog rows. Colours are not identity (REEA-254): they ride inside the
 * merged card as swatches, so the colour field may differ and the group must
 * still fold. Model lines that genuinely differ keep their own cards (the
 * negative controls).
 */
import { describe, expect, it } from "vitest";
import { canonicalFields, compatibleFields } from "@/lib/collect/canonical-product";
import { groupHits, type SearchHit } from "@/lib/collect/live-search";

function hit(title: string, merchant: string, price: number): SearchHit {
  return {
    title,
    merchant,
    price,
    currency: "KWD",
    url: `https://retailer.example/${merchant}/${encodeURIComponent(title)}`,
    inStock: true,
    country: "KW",
  };
}

function merchantsOf(products: ReturnType<typeof groupHits>): string[][] {
  return products.map((p) => [...new Set(p.offers.map((o) => o.merchant))]);
}

describe("REEA-1109 — one HD16 card, not one per colour (dyson)", () => {
  const titles = [
    "Dyson Supersonic Nural Hair Dryer HD16 Apricot Topaz",
    "Dyson Supersonic Nural Hair Dryer HD16 Blue Rich",
    "Dyson Supersonic Nural Hair Dryer HD16 Amber silk",
    "Dyson Supersonic Nural Hd16 - Ceramic Pink",
  ];

  it("folds the device-class descriptor out of the model line", () => {
    for (const title of titles) {
      const f = canonicalFields(title);
      expect(f.modelLine).toBe("dyson supersonic nural hd16");
    }
  });

  it("groupHits folds Eureka + Zayoom HD16 offers into one multi-retailer card", () => {
    const products = groupHits("dyson", [
      hit(titles[0], "Eureka", 179),
      hit(titles[1], "Eureka", 179),
      hit(titles[2], "Eureka", 179),
      hit(titles[3], "Zayoom", 165),
    ]);
    expect(products).toHaveLength(1);
    expect(merchantsOf(products)[0].sort()).toEqual(["Eureka", "Zayoom"]);
    // Every live listing survives the merge as its own offer row — the union
    // preservation contract, not a dropped duplicate.
    expect(products[0].offers).toHaveLength(4);
  });

  it("does not blend a different Dyson model into the HD16 card", () => {
    const hd16 = canonicalFields(titles[0]);
    for (const other of [
      "Dyson Supersonic Mini Hair Dryer, 1000-1220W, 492458-01 - Ceramic pink",
      "Dyson V8 Absolute Cordless Vacuum - SV25 V8 ABS",
      "Dyson V8 Origin Vacuum Cleaner, 115 AW, 630913-01 - Grey",
    ]) {
      expect(compatibleFields(hd16, canonicalFields(other))).toBe(false);
    }
  });
});

describe("REEA-1109 — one DualSense card, not one per colour (ps5)", () => {
  const titles = [
    "Sony PS5 DualSense Wireless Controller Chroma Teal",
    "Sony PS5 Dualsense Wireless Controller Chroma Pearl",
    "Sony PS5 DualSense Wireless Controller - Galactic Purple",
    "Sony PS5 DualSense Wireless Controller",
  ];

  it("folds the official modifier + base colour pair out of the model line", () => {
    for (const title of titles) {
      expect(canonicalFields(title).modelLine).toBe("dualsense controller");
    }
  });

  it("groupHits folds Eureka + Wibi + Astore controller offers into one card", () => {
    const products = groupHits("ps5", [
      hit(titles[0], "Eureka", 24.9),
      hit(titles[1], "Wibi", 25.5),
      hit(titles[2], "Astore", 23),
      hit(titles[3], "Wibi", 21),
    ]);
    expect(products).toHaveLength(1);
    expect(merchantsOf(products)[0].sort()).toEqual(["Astore", "Eureka", "Wibi"]);
  });

  it("keeps DualSense Edge on its own card (a real model-line difference)", () => {
    const edge = "Sony PS5 DualSense Edge Wireless Controller - White";
    expect(
      compatibleFields(
        canonicalFields("Sony PS5 DualSense Wireless Controller Chroma Teal"),
        canonicalFields(edge),
      ),
    ).toBe(false);
  });
});

describe("REEA-1109 — connector spec tail is not identity (headphones)", () => {
  it("folds Jarir's spec-tailed JBL Tune 500 onto Danube Home's short spelling", () => {
    const products = groupHits("headphones", [
      hit("JBL Tune 500 On-Ear Headphones, Wired, 3.5 mm Connector, In-line Microphone, Black", "Jarir", 12),
      hit("JBL Tune 500 On Ear Headphones Black T500BLK", "Danube Home", 9.5),
    ]);
    expect(products).toHaveLength(1);
    expect(merchantsOf(products)[0].sort()).toEqual(["Danube Home", "Jarir"]);
  });

  it("keeps a different Tune model on its own card", () => {
    expect(
      compatibleFields(
        canonicalFields("JBL Tune 500 On Ear Headphones Black T500BLK"),
        canonicalFields("JBL Tune 510BT Wireless Headphones - Black"),
      ),
    ).toBe(false);
  });
});

describe("REEA-1109 — glued capacity spelling joins the storage tier (fold 7)", () => {
  it("normalises Xcite's '512Phone' onto the 512 GB storage slot", () => {
    const glued = canonicalFields("Samsung Galaxy Z Fold7  5G 512Phone - Black");
    expect(glued.storage).toBe("512gb");
    expect(glued.modelLine).toBe("galaxy z fold7");
    expect(
      compatibleFields(
        canonicalFields("Samsung Galaxy Z Fold7 512GB 12GB Ram 5G Black"),
        glued,
      ),
    ).toBe(true);
  });
});
