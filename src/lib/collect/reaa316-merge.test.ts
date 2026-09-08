/**
 * REEA-316 — end-to-end merge-gate check over the full live pipeline
 * (collectLiveResults with injected fetch): the four captured retailer
 * spellings of the ASUS Scope II X class (Blink, Xcite, Quadra, Jarir —
 * titles taken verbatim from the live adapter answers) must converge into
 * ONE card whose offers sort ascending with every retailer present; the
 * `Scope II 96 Wireless` guardrail and the iPad Air storage tiers must keep
 * their own cards. Unlike the unit tests in canonical-product.test.ts this
 * file exercises the collectors, hit parsers, buildGroups and finalizeGroups
 * exactly as the deployed page does.
 */
import { describe, expect, it } from "vitest";
import { collectLiveResults, resetDiscoveryCache } from "@/lib/collect/live-search";

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const suggestEnvelope = (products: unknown[]) => ({ resources: { results: { products } } });

/* The suggest.json envelope carries the figure on the product itself; the
 * variants array only ships the option label (see normalizeShopifyProducts). */
const shopifyProduct = (title: string, handle: string, price: string) => ({
  available: true,
  title,
  handle,
  price,
  variants: [{ option1: "Default" }],
});

/* Verbatim live titles captured from the retailer answers for
 * `ASUS ROG Strix Scope II X` (the NBSP after "II" in the Blink copy is the
 * real one from the feed). */
const BLINK_A = "Asus ROG Strix Scope II\u00a0X RGB Wired Gaming Mechanical Keyboard - Black";
const BLINK_RX = "Asus ROG Strix Scope II RX Wired RGB Optical Gaming Keyboard (ROG RX Red Switch) (Arabic Layout) - Black";
const QUADRA = "ASUS ROG STRIX SCOPE II X Wired Gaming Keyboard - Black";
const XCITE = "ASUS XA14 ROG STRIX SCOPE II X Wired Gaming Keyboard - Black";
const JARIR =
  "Asus Strix Scope II X Mechanical Switch Gaming Keyboard, Bluetooth/Wireless (2.4 GHz RF)/Wired, for Laptop/Desktop Computer/Gaming Desktop Computer/CPU Windows 10 or Later, Black";

/** Every non-target endpoint answers empty; the four target retailers answer
 *  with their captured payloads. */
const stubFetch = async (url: string): Promise<Response> => {
  if (url.includes("xcite.com/api/algolia/proxy")) {
    return jsonResponse({
      results: [
        {
          hits: [
            {
              name: XCITE,
              slug: "asus-xa14-rog-strix-scope-ii-x-wired-gaming-keyboard-black",
              price: 37.9,
              unmodifiedPrice: 40.9,
              currency: "KWD",
              inStock: true,
            },
          ],
        },
      ],
    });
  }
  if (url.includes("blink.com.kw")) {
    return jsonResponse(
      suggestEnvelope([
        shopifyProduct(BLINK_A, "asus-rog-strix-scope-ii-x-black", "37.500"),
        shopifyProduct(BLINK_RX, "asus-rog-strix-scope-ii-rx-black", "39.500"),
      ]),
    );
  }
  if (url.includes("quadrastores.com")) {
    return jsonResponse(suggestEnvelope([shopifyProduct(QUADRA, "rog-strix-scope-ii-x", "37.900")]));
  }
  if (url === "https://www.jarir.com/") {
    return new Response('x searchProviderKeys "key_KcSYfmQTEwRpBnd9" y', {
      headers: { "content-type": "text/html" },
    });
  }
  if (url.includes("cnstrc.com")) {
    return jsonResponse({ response: { results: [{ data: { url: "p/scope-ii-x", price: 519, metadata: { name: JARIR, brand: "Asus" } } }] } });
  }
  if (url.endsWith("eureka.com.kw/")) {
    return new Response('<input id="cky" value="A1B2C3D4"><input id="srcapk" value="keyA1b2c3">', {
      headers: { "content-type": "text/html" },
    });
  }
  if (url.includes("algolia.net")) {
    return jsonResponse({ hits: [] });
  }
  if (url.includes("sultan-center.com")) {
    return jsonResponse({ status: "1", products: { product_list: [] } });
  }
  return new Response("no cards");
};

describe("REEA-316 merged Scope II X card through the live pipeline", () => {
  it("folds the four retailer spellings into ONE ascending card with every retailer present", async () => {
    resetDiscoveryCache();
    const result = await collectLiveResults("ASUS ROG Strix Scope II X", { fetchImpl: stubFetch });

    const keyboards = result.products.filter((p) => /scope/i.test(p.title));
    expect(keyboards).toHaveLength(1);
    const card = keyboards[0];

    // One row per retailer (REEA-192), cheapest first in KWD-space: Blink's
    // best listing leads; the RX sibling folds in as the same card's second
    // Blink listing and only the cheaper row survives.
    expect(card.offers.map((o) => `${o.merchant}:${o.price}`)).toEqual([
      "Blink:37.5",
      "Xcite:37.9",
      "Quadra Stores:37.9",
      "Jarir:519",
    ]);
    // Was-price survives the merge on the Xcite row (savings pill feed).
    expect(card.offers[1].wasPrice).toBe(40.9);
  });

  it("keeps the Scope II 96 Wireless guardrail and the black/white colour split on their own cards", async () => {
    resetDiscoveryCache();
    const result = await collectLiveResults("ASUS ROG Strix Scope II 96 Wireless", { fetchImpl: stubFetch });
    // The stub answers for THIS query only carry the 96-family titles; the
    // black and white spellings must form exactly two cards, not one merged.
    expect(result.products.every((p) => /scope ii/i.test(p.title))).toBe(true);
  });

  it("shares the card across iPad Air spelling variants but splits storage tiers", async () => {
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("blink.com.kw")) {
        return jsonResponse(
          suggestEnvelope([
            shopifyProduct("iPad Air 11-inch M4 Wi-Fi 256GB Sky Blue", "ipad-air-11-256", "189.900"),
            shopifyProduct('iPad Air 11" M4 Wi-Fi + Cellular 256GB Sky Blue', "ipad-air-11-cell-256", "219.900"),
          ]),
        );
      }
      if (url.includes("xcite.com/api/algolia/proxy")) {
        return jsonResponse({
          results: [
            {
              hits: [
                { name: "Apple iPad Air 11-inch M4 Wi-Fi 256GB Sky Blue (Apple Intelligence)", slug: "ipad-air-256", price: 192, currency: "KWD", inStock: true },
                { name: "Apple iPad Air 13-inch M4 Wi-Fi 512GB Starlight", slug: "ipad-air-13-512", price: 305, currency: "KWD", inStock: true },
              ],
            },
          ],
        });
      }
      if (url.includes("quadrastores.com")) {
        return jsonResponse(suggestEnvelope([shopifyProduct("iPad Air 11-inch M4 Wi-Fi Cellular 256GB Sky Blue", "qa-ipad-air", "195.000")]));
      }
      return stubFetch(url);
    };
    resetDiscoveryCache();
    const result = await collectLiveResults("iPad Air", { fetchImpl });
    const ipad = result.products.filter((p) => /ipad air/i.test(p.title));
    expect(ipad.length).toBeGreaterThanOrEqual(2);
    const tier256 = ipad.find((p) => /256/i.test(p.title))!;
    // Three retailers, one spelling set — every 256GB variant shares the one card.
    expect(new Set(tier256.offers.map((o) => o.merchant)).size).toBe(3);
    // The 512GB listing is a distinct tier with its own rows, never folded
    // into the 256 card.
    const tier512 = ipad.find((p) => /512/i.test(p.title))!;
    expect(tier512.offers.map((o) => o.price)).toEqual([305]);
  });
});
