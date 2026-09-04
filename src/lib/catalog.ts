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
        price: 42.5,
        currency: "KWD",
        url: "https://www.xcite.com/asus-rog-strix-scope-ii-96",
        inStock: true,
        wasPrice: 49,
      },
      {
        merchant: "Jarir Bookstore Kuwait",
        price: 44.75,
        currency: "KWD",
        url: "https://www.jarir.com/kw/asus-rog-strix-scope-ii",
        inStock: true,
      },
      {
        merchant: "Amazon.eg (ships to KW)",
        price: 41.2,
        currency: "KWD",
        url: "https://www.amazon.eg/asus-rog-strix-scope-ii",
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
        price: 24.9,
        currency: "KWD",
        url: "https://www.xcite.com/asus-rog-keris-ii",
        inStock: true,
      },
      {
        merchant: "Talabat Tech Mart",
        price: 26.5,
        currency: "KWD",
        url: "https://techmart.talabat.com/kw/asus-rog-keris-ii",
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
        url: "https://www.jarir.com/kw/razer-huntsman-v3-pro-tkl",
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
        price: 38,
        currency: "KWD",
        url: "https://www.xcite.com/logitech-g-pro-x-tkl",
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
        url: "https://www.jarir.com/kw/logitech-g-pro-x-superlight-2",
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
        price: 119,
        currency: "KWD",
        url: "https://www.xcite.com/sony-wh-1000xm6",
        inStock: true,
      },
      {
        merchant: "Berry Electronics",
        price: 114.5,
        currency: "KWD",
        url: "https://berry.com.kw/sony-wh-1000xm6",
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
        url: "https://berry.com.kw/bose-qc-ultra",
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
        price: 389,
        currency: "KWD",
        url: "https://www.xcite.com/iphone-17-pro-256",
        inStock: true,
      },
      {
        merchant: "Jarir Bookstore Kuwait",
        price: 395,
        currency: "KWD",
        url: "https://www.jarir.com/kw/iphone-17-pro",
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
        price: 370,
        currency: "KWD",
        url: "https://www.xcite.com/galaxy-s26-ultra",
        inStock: true,
        wasPrice: 399,
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
        url: "https://berry.com.kw/ps5-slim-bundle",
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
        price: 118,
        currency: "KWD",
        url: "https://www.xcite.com/xbox-series-s-1tb",
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
        url: "https://www.amazon.eg/keychron-v3-max",
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
