// @vitest-environment jsdom
/**
 * REEA-1261 — the served shelf for a brand+model query.
 *
 * Live defect (`ffaf8fd`): `keychron v3 max` painted nine Razer cards as peer
 * results and zero Keychron, while the count line claimed in-scope products
 * and the PDP showed the exact product with an Egypt-only price. This test
 * pins the rendered contract the ACs name: the exact model is the FIRST
 * primary card, every unrelated-brand row is below the labelled "Related
 * items" divider (never a peer card, never the accessory band), and the count
 * line counts exactly the exact-model cards with the "none in Kuwait"
 * disclosure.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/results",
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode; [k: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import ResultsClient from "@/components/ResultsClient";
import { resetCountryPrefs } from "@/lib/country";
import { classifyProductScope } from "@/lib/scope-gate";
import type { NormalizedProduct } from "@/types/product";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const QUERY = "keychron v3 max";

const offer = (
  merchant: string,
  price: number,
  currency: string,
  market: string,
): NormalizedProduct["offers"][number] => ({
  merchant,
  price,
  currency,
  market,
  url: `https://${merchant.toLowerCase()}.example/p`,
  inStock: true,
  collectedAt: "2026-11-27T16:20:00.000Z",
  method: "cache",
}) as unknown as NormalizedProduct["offers"][number];

const card = (
  id: string,
  title: string,
  offers: NormalizedProduct["offers"],
): NormalizedProduct => ({
  productId: id,
  title,
  brand: "Keychron",
  offers,
  coupons: [],
  variations: [],
  alternatives: [],
  scrapedAt: "2026-11-27T16:20:00.000Z",
  ...classifyProductScope(QUERY, title),
});

const RAZER_TITLES = [
  "RAZER ORNATA V3 TKL RGB Wired Mecha-Membrane Keyboard - Black",
  "RAZER HUNTSMAN V3 Tenkeyless 8KHz Analog Optical Esports Wired Gaming Keyboard - Black",
  "RAZER DeathAdder V3 Pro Wireless Gaming Mouse - Black",
];

const SHELF: NormalizedProduct[] = [
  // The seeded exact-model card: identity from the catalog, price from the
  // stored live observation (Amazon.eg, EG stock, marked "cache").
  card("keychron-v3-max", "Keychron V3 Max QMK Wireless Mechanical Keyboard", [
    offer("Amazon.eg", 700, "EGP", "EG"),
  ]),
  ...RAZER_TITLES.map((title, i) =>
    card(`razer-${i}`, title, [offer("Quadra Stores", 21.9 + i, "KWD", "KW")]),
  ),
];

function renderShelf(locale: "en" | "ar") {
  resetCountryPrefs();
  vi.stubGlobal("navigator", {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    sendBeacon: () => true,
  });
  return render(
    <ResultsClient
      query={QUERY}
      products={SHELF}
      country="KW"
      showOutOfStock={false}
      locale={locale}
      renderStartMs={Date.parse("2026-11-27T16:20:05.000Z")}
    />,
  );
}

describe("REEA-1261 AC-1 — the exact model is the first primary card", () => {
  it("leads with the Keychron and keeps every Razer row off the primary shelf", () => {
    const { container } = renderShelf("en");
    const primary = container.querySelector("[data-primary-section]") as HTMLElement;
    expect(primary).not.toBeNull();
    const cards = primary.querySelectorAll("article.rc-card");
    expect(cards.length).toBe(1);
    expect(cards[0]?.textContent).toContain("Keychron V3 Max");
    // 0 unrelated-brand cards above it (and none beside it).
    expect(primary.textContent).not.toContain("RAZER ORNATA");
    expect(primary.textContent).not.toContain("DeathAdder");
  });
});

describe("REEA-1261 AC-3 — neighbours render below the labelled related divider", () => {
  it("puts the Razer rows in the related band, after the primary shelf", () => {
    const { container } = renderShelf("en");
    const band = container.querySelector("[data-related-band]") as HTMLElement;
    expect(band).not.toBeNull();
    expect(band.textContent).toContain("Related items");
    const items = band.querySelectorAll("[data-related-item]");
    expect(items.length).toBe(RAZER_TITLES.length);
    // Document order: primary shelf first, related band after it.
    const order = Array.from(
      container.querySelectorAll("[data-primary-section], [data-related-band]"),
    ).map((el) => (el.hasAttribute("data-primary-section") ? "primary" : "related"));
    expect(order).toEqual(["primary", "related"]);
    // Never the accessory band: a Razer keyboard is not an accessory of a
    // Keychron keyboard.
    expect(container.querySelector("[data-accessory-band]")).toBeNull();
  });
});

describe("REEA-1261 AC-2 — the count line is the exact-model count", () => {
  it("states the cross-market disclosure in EN", () => {
    const { container } = renderShelf("en");
    const line = container.querySelector("[data-exact-model-count]") as HTMLElement;
    expect(line).not.toBeNull();
    expect(line.textContent).toBe("1 retailer carries this model · none in Kuwait");
    expect(line.getAttribute("data-exact-model-total")).toBe("1");
    expect(line.getAttribute("data-exact-model-none-in-market")).toBe("true");
    // The old in-scope sentence is replaced, not stacked.
    expect(container.querySelector("[data-in-scope-count]")).toBeNull();
  });

  it("states the same disclosure in AR", () => {
    const { container } = renderShelf("ar");
    const line = container.querySelector("[data-exact-model-count]") as HTMLElement;
    expect(line).not.toBeNull();
    expect(line.textContent).toContain("متجر واحد يبيع هذا الموديل");
    expect(line.textContent).toContain("لا يوجد عرض في الكويت");
    expect(line.getAttribute("data-exact-model-total")).toBe("1");
  });
});
