import { describe, expect, it } from "vitest";
import { binsinaHits, luluListHits, nextStoreHits, nextStoreMarkdownHits, yousifiOccHits } from "@/lib/collect/live-search";
import { browserTierEnabled, relayTierEnabled } from "@/lib/collect/browser-clearance";
import { coverageParts, type LiveSearchResult } from "@/lib/collect/coverage";

/**
 * REEA-1221 — lane repair guardrails. Each case pins one measured cause the
 * ticket diagnosed on the served head, so the same drift cannot silently
 * return a zero-offer lane again.
 */
describe("REEA-1221 lane repair", () => {
  it("BinSina reads the served price box whose class carries an escaped space", () => {
    // Measured live 2026-11-26 on www.binsina.ae/en/catalogsearch/result?q=panadol:
    // the grid renders `<div class="price&#x20;price-cust"> 32.00 </div>`.
    // The old exact `class="price"` selector matched nothing, so the lane
    // answered 0 hits on every query while its hop succeeded (a silent zero).
    const html =
      '<strong class="product name product-item-name"><a class="product-item-link" ' +
      'href="https://www.binsina.ae/en/buy-panadol-migraine-tablets-24-s.html">' +
      "Panadol Migraine Caplets 24 Caplets</a></strong>" +
      '<div class="left "><div class="price&#x20;price-cust"> 32.00 </div></div>';
    const hits = binsinaHits(html, "panadol");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      merchant: "BinSina",
      title: "Panadol Migraine Caplets 24 Caplets",
      price: 32,
      currency: "AED",
      url: "https://www.binsina.ae/en/buy-panadol-migraine-tablets-24-s.html",
    });
  });

  it("BinSina takes the product title, not the cart button's title attribute", () => {
    // The served grid also stamps `title="Add&#x20;to&#x20;Bag"` on the cart
    // button further down the card. Reading the first `title=` anywhere in the
    // segment made every card adopt that label, and the coverage gate rejected
    // all 19 priced rows (measured live 2026-11-26 on `panadol`).
    const html =
      '<a class="product-item-link" href="https://www.binsina.ae/en/buy-panadol-night-tablets-24-s.html">' +
      "Panadol Night Tablets 24&#039;s</a>" +
      '<div class="price&#x20;price-cust"> 21.00 </div>' +
      '<button title="Add&#x20;to&#x20;Bag">Add to Bag</button>';
    const hits = binsinaHits(html, "panadol");
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe("Panadol Night Tablets 24's");
    expect(hits[0].price).toBe(21);
  });

  it("BinSina skips a price-box container and takes the nested figure", () => {
    const html =
      '<a class="product-item-link" href="/en/buy-panadol-extra-optizorb-tablets-24-s.html">' +
      "Panadol Extra Optizorb Tablets 24&#039;s</a>" +
      '<div class="price-box price-final_price">' +
      '<span class="price-wrapper"><span class="price">AED 18.50</span></span></div>';
    const hits = binsinaHits(html, "panadol");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ price: 18.5, currency: "AED" });
  });

  it("Next Store reads the browser-painted Magento grid, not the cart button label", () => {
    // Measured live 2026-11-26: the real-browser clearance tier paints the
    // grid (13 priced cards on `laptop`), but the card carries a
    // `title="Add to Bag"` cart control the old "first title= in segment"
    // read adopted, which the coverage gate then rejected.
    const html =
      '<a class="product-item-link" href="https://www.nextstore.com.kw/razer-laptop-sleeve.html">' +
      "Razer Laptop Sleeve 16</a>" +
      '<span data-price-amount="34" data-price-type="finalPrice"></span>' +
      '<button title="Add to Bag">Add to Bag</button>';
    const hits = nextStoreHits(html, "laptop");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      merchant: "Next Store",
      title: "Razer Laptop Sleeve 16",
      price: 34,
      currency: "KWD",
    });
  });

  it("Lulu reads the Kuwait list page's priced cards, not the retired JSON-LD contract", () => {
    // Measured live 2026-11-26 on
    // https://gcc.luluhypermarket.com/en-kw/list/?search_text=laptop: the page
    // ships no Product JSON-LD any more (only WebSite + Organization), and the
    // cards carry app-product-card with the selling price in
    // data-testid="product-price" as "2.900 KWD".
    const html =
      '<div class="relative rounded-v2-xs border app-product-card justify-start">' +
      '<a class="relative z-0 flex flex-col" href="/en-kw/wagon-r-vibes-laptop-bag-5001/p/1641941/">' +
      '<img alt="Wagon R Vibes Laptop Bag 5001 15.6 inches hover image" /></a>' +
      '<div class="app-card-price"><span class="text-black" data-testid="product-price">2.900 KWD</span>' +
      '<span class="line-through" data-testid="product-price">4.900</span></div></div>';
    const hits = luluListHits(html, "laptop");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      merchant: "Lulu Hypermarket",
      title: "Wagon R Vibes Laptop Bag 5001 15.6 inches",
      price: 2.9,
      currency: "KWD",
      url: "https://gcc.luluhypermarket.com/en-kw/wagon-r-vibes-laptop-bag-5001/p/1641941/",
      wasPrice: 4.9,
    });
  });

  it("does not call a lane that missed the completion budget unreachable", () => {
    // Measured on the served head 2026-11-26: the first paint named Lulu,
    // Ounass and Next Store "Unreachable" because their relay/browser hops had
    // not settled inside the 1.8 s budget, while the same run's converged
    // snapshot had all three answering. A budget miss is "still checking", not
    // a blocked lane.
    const notes = [
      { merchant: "Lulu Hypermarket", hits: 0, coupons: 0, error: "no answer within the 1800 ms completion budget" },
      { merchant: "Ounass", hits: 0, coupons: 0, error: "no answer within the 1800 ms completion budget" },
      { merchant: "Bomai", hits: 0, coupons: 0, error: "blocked: no usable payload (0 hits, no explicit no-match from Bomai)" },
      { merchant: "Xcite", hits: 3, coupons: 0 },
    ] as unknown as LiveSearchResult["notes"];
    const parts = coverageParts(notes, "en", [{ productId: "p1", offers: [{ merchant: "Xcite" }] }] as never, [], "laptop");
    const text = parts.map((p) => (p.kind === "text" ? p.value : p.names.join(", "))).join("");
    // Only the UNREACHABLE sentence is under test here — a budget miss may
    // still ride "No response from …", which is the honest word for it.
    const unreachable = text.slice(text.indexOf("Unreachable: "), text.indexOf(".", text.indexOf("Unreachable: ")));
    expect(unreachable).toContain("Bomai");
    expect(unreachable).not.toContain("Lulu Hypermarket");
    expect(unreachable).not.toContain("Ounass");
  });

  it("Next Store reads the relay's markdown render (its html mode returns the challenge)", () => {
    // Measured 2026-11-26: the same reader relay answers Next Store's search
    // page as 81 KB of markdown carrying ten priced rows, while its html mode
    // hands back the 5.9 KB "Just a moment" shell. The row shape is
    // **[Title](product url "Title")**[Brand](…)\nKD 109.000 …
    const md =
      'Markdown Content:\n**[Razer Laptop Sleeve 16](https://www.nextstore.com.kw/razer-laptop-sleeve-16.html "Razer Laptop Sleeve 16")**[Razer](https://www.nextstore.com.kw/brand/razer) KD 34.000 KNET\n' +
      '**[UGreen Desktop Laptop Stand](https://www.nextstore.com.kw/ugreen-desktop-laptop-stand.html "UGreen Desktop Laptop Stand")**[UGreen](https://www.nextstore.com.kw/brand/ugreen) KD 5.000 KNET\n';
    const hits = nextStoreMarkdownHits(md, "laptop");
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({
      merchant: "Next Store",
      title: "Razer Laptop Sleeve 16",
      price: 34,
      currency: "KWD",
      url: "https://www.nextstore.com.kw/razer-laptop-sleeve-16.html",
    });
  });

  it("Yousifi reads Best Al-Yousifi's OCC rows and treats an empty answer as no-match", () => {
    // REEA-1221 — PM ruling on REEA-1225 re-pointed this lane to the live shop's
    // SAP Commerce OCC search API. Measured live 2026-11-26:
    // `iphone 17 pro` → 10 products at KWD 444.9, `panadol` → 0 products.
    const payload = {
      products: [
        {
          name: "Apple iPhone 17 Pro Max 256GB Esim - Blue",
          code: "IP17PM256BL",
          url: "/All-Categories/Mobiles/iPhone-17-Pro-Max/p/IP17PM256BL",
          price: { currencyIso: "KWD", value: 444.9 },
          stock: { stockLevelStatus: "inStock" },
        },
        {
          name: "Promate Laptop Backpack for 15inch Laptop",
          url: "/All-Categories/Travel-and-Bags/Backpack/p/REBEL-BP-BLACK",
          price: { currencyIso: "KWD", value: 11.9 },
          stock: { stockLevelStatus: "outOfStock" },
        },
      ],
    };
    const hits = yousifiOccHits(payload, "iphone 17 pro");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      merchant: "Yousifi",
      title: "Apple iPhone 17 Pro Max 256GB Esim - Blue",
      price: 444.9,
      currency: "KWD",
      inStock: true,
      url: "https://best.com.kw/en/All-Categories/Mobiles/iPhone-17-Pro-Max/p/IP17PM256BL",
    });
    // An empty products array is the retailer saying "no match".
    expect(yousifiOccHits({ products: [] }, "panadol")).toEqual([]);
  });

  it("keeps both clearance tiers out of the hermetic test run", () => {
    // The unit suite must not pay a Chromium launch OR a public-internet relay
    // round trip: a real relay call inside the fake-fetch tests turned one
    // expected product into ten and blew the 5 s budget in CI (2026-11-26).
    // The self-hosted runtime and local dev still run both tiers.
    expect(process.env.NODE_ENV).toBe("test");
    expect(browserTierEnabled()).toBe(false);
    expect(relayTierEnabled()).toBe(false);
  });
});
