import { describe, expect, it } from "vitest";
import { binsinaHits } from "@/lib/collect/live-search";

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
});
