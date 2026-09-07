/**
 * Seed catalog for the static export.
 *
 * TODO(data-engineer): replace with the Scraping/Data Engineer's normalized
 * feed (keep the NormalizedProduct shape in src/types/product.ts). This file
 * is bundled into the client so the static export needs no runtime API.
 */
import type { NormalizedProduct } from "@/types/product";

export const CATALOG: NormalizedProduct[] = [
  {
    productId: "asus-rog-strix-scope-ii",
    title: "ASUS ROG Strix Scope II 96 Wireless Gaming Keyboard",
    brand: "ASUS",
    offers: [
      {
        merchant: "Xcite",
        price: 47.9,
        currency: "KWD",
        url: "https://www.xcite.com/asus-rog-x901-strix-scope-ii-96-rgb-wireless-gaming-arabic-keyboard-black/p",
        inStock: true,
        wasPrice: 49,
      },
      {
        merchant: "Jarir Bookstore Kuwait",
        price: 44.75,
        currency: "KWD",
        url: "https://www.jarir.com/?q=ASUS%20ROG%20Strix%20Scope%20II%2096%20Wireless%20Gaming%20Keyboard",
        inStock: true,
      },
      {
        merchant: "Amazon.eg (ships to KW)",
        price: 41.2,
        currency: "KWD",
        url: "https://www.amazon.eg/s?k=ASUS%20ROG%20Strix%20Scope%20II%2096%20Wireless%20Gaming%20Keyboard",
        inStock: true,
      },
    ],
    coupons: [
      {
        code: "ROG10",
        description: "10% off ASUS ROG accessories",
        discount: "10% off",
        expiresAt: "2026-12-31T23:59:59Z",
      },
    ],
    variations: [
      { id: "scope2-black", label: "Black", priceDelta: 0 },
      { id: "scope2-white", label: "Moonlight White", priceDelta: 2.5 },
    ],
    alternatives: [
      {
        productId: "razer-huntsman-v3-pro",
        title: "Razer Huntsman V3 Pro TKL",
        fromPrice: 55,
      },
      {
        productId: "logitech-pro-x-tkl",
        title: "Logitech G PRO X TKL Lightspeed",
        fromPrice: 38,
      },
    ],
  },
  {
    productId: "asus-rog-keris-ii-aimpoint",
    title: "ASUS ROG Keris II AimPoint Wireless Gaming Mouse",
    brand: "ASUS",
    offers: [
      {
        merchant: "Xcite",
        price: 34.9,
        currency: "KWD",
        url: "https://www.xcite.com/asus-p722-rog-keris-ii-origin-wireless-rgb-gaming-mouse-black/p",
        inStock: true,
      },
      {
        merchant: "Talabat Tech Mart",
        price: 26.5,
        currency: "KWD",
        url: "https://www.talabat.com/en/kuwait",
        inStock: false,
      },
    ],
    coupons: [],
    variations: [{ id: "keris2-black", label: "Black", priceDelta: 0 }],
    alternatives: [
      {
        productId: "logitech-gpro-superlight-2",
        title: "Logitech G PRO Superlight 2",
        fromPrice: 32,
      },
    ],
  },
  {
    productId: "razer-huntsman-v3-pro",
    title: "Razer Huntsman V3 Pro TKL Analog Optical Keyboard",
    brand: "Razer",
    offers: [
      {
        merchant: "Jarir Bookstore Kuwait",
        price: 55,
        currency: "KWD",
        url: "https://www.jarir.com/?q=Razer%20Huntsman%20V3%20Pro%20TKL",
        inStock: true,
      },
    ],
    coupons: [
      {
        code: null,
        description: "Free shipping over 25 KWD",
        discount: "Free shipping",
        expiresAt: null,
      },
    ],
    variations: [],
    alternatives: [
      {
        productId: "asus-rog-strix-scope-ii",
        title: "ASUS ROG Strix Scope II 96 Wireless",
        fromPrice: 41.2,
      },
    ],
  },
  {
    productId: "logitech-pro-x-tkl",
    title: "Logitech G PRO X TKL Lightspeed Wireless Keyboard",
    brand: "Logitech",
    offers: [
      {
        merchant: "Xcite",
        price: 77.9,
        currency: "KWD",
        url: "https://www.xcite.com/logitech-pro-x-tkl-lightspeed-wireless-gaming-keyboard-920-012148-white/p",
        inStock: true,
        wasPrice: 42,
      },
    ],
    coupons: [],
    variations: [],
    alternatives: [
      {
        productId: "asus-rog-strix-scope-ii",
        title: "ASUS ROG Strix Scope II 96 Wireless",
        fromPrice: 41.2,
      },
    ],
  },
  {
    productId: "logitech-gpro-superlight-2",
    title: "Logitech G PRO X Superlight 2 Wireless Gaming Mouse",
    brand: "Logitech",
    offers: [
      {
        merchant: "Jarir Bookstore Kuwait",
        price: 32,
        currency: "KWD",
        url: "https://www.jarir.com/?q=Logitech%20G%20PRO%20X%20Superlight%202",
        inStock: true,
      },
    ],
    coupons: [],
    variations: [
      { id: "gpx2-black", label: "Black", priceDelta: 0 },
      { id: "gpx2-white", label: "White", priceDelta: 1 },
    ],
    alternatives: [
      {
        productId: "asus-rog-keris-ii-aimpoint",
        title: "ASUS ROG Keris II AimPoint",
        fromPrice: 24.9,
      },
    ],
  },
  {
    productId: "sony-wh-1000xm6",
    title: "Sony WH-1000XM6 Wireless Noise Cancelling Headphones",
    brand: "Sony",
    offers: [
      {
        merchant: "Xcite",
        price: 99.9,
        currency: "KWD",
        url: "https://www.xcite.com/sony-wireless-noise-cancelling-headphone-wh-1000xm6-s-silver/p",
        inStock: true,
      },
      {
        merchant: "Berry Electronics",
        price: 114.5,
        currency: "KWD",
        url: "https://www.bing.com/search?q=Berry%20Electronics%20Sony%20WH-1000XM6%20Wireless%20Noise%20Cancelling%20Headphones",
        inStock: true,
        wasPrice: 129,
      },
    ],
    coupons: [
      {
        code: "SONY15",
        description: "15% off Sony audio",
        discount: "15% off",
        expiresAt: "2026-10-31T23:59:59Z",
      },
    ],
    variations: [
      { id: "xm6-black", label: "Black", priceDelta: 0 },
      { id: "xm6-silver", label: "Platinum Silver", priceDelta: 0 },
    ],
    alternatives: [
      {
        productId: "bose-qc-ultra",
        title: "Bose QuietComfort Ultra Headphones",
        fromPrice: 125,
      },
    ],
  },
  {
    productId: "bose-qc-ultra",
    title: "Bose QuietComfort Ultra Wireless Headphones",
    brand: "Bose",
    offers: [
      {
        merchant: "Berry Electronics",
        price: 125,
        currency: "KWD",
        url: "https://www.bing.com/search?q=Berry%20Electronics%20Bose%20QuietComfort%20Ultra%20Wireless%20Headphones",
        inStock: true,
      },
    ],
    coupons: [],
    variations: [],
    alternatives: [
      {
        productId: "sony-wh-1000xm6",
        title: "Sony WH-1000XM6",
        fromPrice: 114.5,
      },
    ],
  },
  {
    productId: "iphone-17-pro",
    title: "Apple iPhone 17 Pro 256GB",
    brand: "Apple",
    offers: [
      {
        merchant: "Xcite",
        price: 374.9,
        currency: "KWD",
        url: "https://www.xcite.com/apple-iphone-17-pro-6-3-256gb-silver/p",
        inStock: true,
      },
      {
        merchant: "Jarir Bookstore Kuwait",
        price: 395,
        currency: "KWD",
        url: "https://www.jarir.com/?q=Apple%20iPhone%2017%20Pro%20256GB",
        inStock: true,
      },
    ],
    coupons: [
      {
        code: "KWT5",
        description: "5% off with KWT bank card",
        discount: "5% off",
        expiresAt: "2026-11-30T23:59:59Z",
      },
    ],
    variations: [
      { id: "ip17p-256", label: "256GB", priceDelta: 0 },
      { id: "ip17p-512", label: "512GB", priceDelta: 60 },
    ],
    alternatives: [
      {
        productId: "galaxy-s26-ultra",
        title: "Samsung Galaxy S26 Ultra 256GB",
        fromPrice: 370,
      },
    ],
  },
  {
    productId: "galaxy-s26-ultra",
    title: "Samsung Galaxy S26 Ultra 256GB",
    brand: "Samsung",
    offers: [
      {
        merchant: "Xcite",
        price: 299.9,
        currency: "KWD",
        url: "https://www.xcite.com/samsung-s26-ultra-5g-phone-6-3-12gb-256gb-white/p",
        inStock: true,
        wasPrice: 399,
      },
      {
        merchant: "Jarir Bookstore Kuwait",
        price: 315,
        currency: "KWD",
        url: "https://www.jarir.com/?q=Samsung%20Galaxy%20S26%20Ultra%20256GB",
        inStock: true,
      },
      {
        merchant: "Amazon.eg (ships to KW)",
        price: 305.5,
        currency: "KWD",
        url: "https://www.amazon.eg/s?k=Samsung%20Galaxy%20S26%20Ultra%20256GB",
        inStock: true,
      },
    ],
    coupons: [],
    variations: [],
    alternatives: [
      { productId: "iphone-17-pro", title: "Apple iPhone 17 Pro", fromPrice: 389 },
    ],
  },
  {
    productId: "ps5-slim-bundle",
    title: "Sony PlayStation 5 Slim Digital Edition + Extra Controller",
    brand: "Sony",
    offers: [
      {
        merchant: "Berry Electronics",
        price: 172,
        currency: "KWD",
        url: "https://www.bing.com/search?q=Berry%20Electronics%20Sony%20PlayStation%205%20Slim%20Digital%20Edition%20%2B%20Extra%20Controller",
        inStock: true,
      },
    ],
    coupons: [],
    variations: [],
    alternatives: [
      {
        productId: "xbox-series-s",
        title: "Microsoft Xbox Series S 1TB",
        fromPrice: 118,
      },
    ],
  },
  {
    productId: "xbox-series-s",
    title: "Microsoft Xbox Series S 1TB Console",
    brand: "Microsoft",
    offers: [
      {
        merchant: "Xcite",
        price: 139.9,
        currency: "KWD",
        url: "https://www.xcite.com/microsoft-xbox-series-s-all-digital-gaming-console-1tb-ssd-xxu-00013-carbon-black/p",
        inStock: false,
      },
    ],
    coupons: [],
    variations: [],
    alternatives: [
      {
        productId: "ps5-slim-bundle",
        title: "PlayStation 5 Slim Digital + Controller",
        fromPrice: 172,
      },
    ],
  },
  {
    productId: "keychron-v3-max",
    title: "Keychron V3 Max QMK Wireless Mechanical Keyboard",
    brand: "Keychron",
    offers: [
      {
        merchant: "Amazon.eg (ships to KW)",
        price: 33.5,
        currency: "KWD",
        url: "https://www.amazon.eg/s?k=Keychron%20V3%20Max%20QMK%20Wireless%20Mechanical%20Keyboard",
        inStock: true,
      },
    ],
    coupons: [],
    variations: [
      { id: "v3max-brown", label: "Brown switches", priceDelta: 0 },
      { id: "v3max-red", label: "Red switches", priceDelta: 0 },
    ],
    alternatives: [
      {
        productId: "asus-rog-strix-scope-ii",
        title: "ASUS ROG Strix Scope II 96 Wireless",
        fromPrice: 41.2,
      },
    ],
  },
];

/**
 * REEA-65 §4.1 seed freshness fixture: last-verified timestamps (hours before
 * build time) so the deployed catalog exercises every freshness bucket —
 * fresh (<24h), stale (>7d, "may be outdated"), and one metadata-less product
 * ("Verification date unknown"). The real feed replaces this with per-record
 * `scraped_at` from the scraping pipeline; the mapping is this one place.
 */
const BUILD_TIME = Date.now();
const hoursBeforeBuild = (h: number): string =>
  new Date(BUILD_TIME - h * 60 * 60 * 1000).toISOString();

const FRESHNESS_FIXTURE_HOURS: Record<string, number | undefined> = {
  "asus-rog-strix-scope-ii": 3,
  "asus-rog-keris-ii-aimpoint": 9,
  "logitech-gpro-superlight-2": 30,
  "razer-huntsman-v3-pro": 52,
  "logitech-pro-x-tkl": 74,
  "sony-wh-1000xm6": 8,
  "bose-qc-ultra": 24 * 9, // stale: >7d
  "iphone-17-pro": 5,
  "galaxy-s26-ultra": 27,
  "ps5-slim-bundle": 24 * 12, // stale: >7d
  "xbox-series-s": 2,
  // keychron-v3-max: deliberately omitted — renders "Verification date unknown".
};

for (const product of CATALOG) {
  const hours = FRESHNESS_FIXTURE_HOURS[product.productId];
  if (hours != null) product.scrapedAt = hoursBeforeBuild(hours);
}
