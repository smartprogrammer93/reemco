// @vitest-environment jsdom
/**
 * REEA-37 — results-page funnel wiring test (AC-1 client side).
 * Renders ResultsClient with a mocked router/search-params and stubbed
 * transport, asserting search_submitted + result_impressed (+ zero_results)
 * fire with the correct fields once per query/page.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { act } from "react";
import { coverageLine } from "@/lib/collect/coverage";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const searchParams = new URLSearchParams();
const refreshSpy = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
  usePathname: () => "/results",
  useRouter: () => ({ refresh: refreshSpy, replace: refreshSpy }),
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

import ResultsClient, { LoadingFallback } from "@/components/ResultsClient";
import HeaderSearch from "@/components/HeaderSearch";
import { resetStockPrefs } from "@/lib/stock";
import type { LiveSearchResult } from "@/lib/collect/live-search";
import type { NormalizedProduct } from "@/types/product";

const beaconCalls: { url: string; body: unknown }[] = [];

beforeEach(() => {
  searchParams.set("q", "");
  beaconCalls.length = 0;
  vi.stubGlobal("navigator", {
    sendBeacon: (url: string, blob: Blob) => {
      void blob.text().then((text) => beaconCalls.push({ url, body: JSON.parse(text) }));
      return true;
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function eventsSent(): { type: string; [k: string]: unknown }[] {
  return beaconCalls.flatMap((c) => (c.body as { events: [] }).events);
}

// REEA-114: ResultsClient renders exactly what the server collected, so the
// test feeds it a minimal normalized product the same way the page does.
const SAMPLE_PRODUCTS: NormalizedProduct[] = [
  {
    productId: "sony-wh-1000xm6",
    title: "Sony WH-1000XM6",
    brand: "Sony",
    offers: [
      { merchant: "Jarir", price: 1299, currency: "SAR", url: "https://www.jarir.com/", inStock: true },
    ],
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-09-07T00:00:00.000Z",
  },
];

describe("ResultsClient funnel instrumentation", () => {
  it("fires search_submitted and result_impressed for a query with results", async () => {
    searchParams.set("q", "sony");
    await act(async () => {
      render(
        <ResultsClient query="sony" page={1} products={SAMPLE_PRODUCTS} suggestions={SAMPLE_PRODUCTS} />,
      );
    });
    const evts = eventsSent();
    const search = evts.find((e) => e.type === "search_submitted");
    expect(search).toMatchObject({ type: "search_submitted", query: "sony" });
    expect(Number(search?.result_count)).toBeGreaterThan(0);
    const impressions = evts.filter((e) => e.type === "result_impressed");
    expect(impressions.length).toBeGreaterThan(0);
    expect(impressions[0]).toMatchObject({ query: "sony", rank: 0 });
    expect(typeof impressions[0].item_id).toBe("string");
    // deduped: no second batch on re-render of the same query/page
    const before = beaconCalls.length;
    await act(async () => {
      render(
        <ResultsClient query="sony" page={1} products={SAMPLE_PRODUCTS} suggestions={SAMPLE_PRODUCTS} />,
      );
    });
    expect(beaconCalls.length).toBeLessThanOrEqual(before + 1);
  });

  it("fires zero_results for a query with no matches", async () => {
    searchParams.set("q", "zzzqqqnothing");
    await act(async () => {
      render(
        <ResultsClient query="zzzqqqnothing" page={1} products={[]} suggestions={[]} />,
      );
    });
    const evts = eventsSent();
    expect(evts.some((e) => e.type === "zero_results" && e.query === "zzzqqqnothing")).toBe(true);
    const search = evts.find((e) => e.type === "search_submitted");
    expect(search?.result_count).toBe(0);
  });
});

describe("country filter UI (REEA-170)", () => {
  const MIXED: NormalizedProduct[] = [
    {
      productId: "airpods-pro-2",
      title: "Apple AirPods Pro 2",
      brand: "Apple",
      offers: [
        { merchant: "Xcite", price: 74, currency: "KWD", url: "https://xcite.example/p", inStock: true },
        { merchant: "Jarir", price: 909, currency: "SAR", url: "https://jarir.example/p", inStock: true },
      ],
      coupons: [],
      variations: [],
      alternatives: [],
    },
  ];

  it("renders the pills and keeps only matching-offer retailers under Kuwait", async () => {
    searchParams.set("q", "airpods");
    await act(async () => {
      render(
        <ResultsClient query="airpods" page={1} products={MIXED} suggestions={MIXED} country="KW" />,
      );
    });
    const pills = Array.from(
      document.querySelectorAll('nav[aria-label="Filter offers by country"] button'),
    );
    expect(pills.map((b) => b.textContent)).toEqual([
      "All",
      "Kuwait (KWD)",
      "Saudi Arabia (SAR)",
      "Egypt (EGP)",
    ]);
    // REEA-291 AC4: pills are in-place controls — the active one is marked,
    // no link navigation involved. Clicking another pill filters the loaded
    // payload on the client without any navigation.
    expect(pills[1].getAttribute("aria-current")).toBe("true");
    const html = document.body.innerHTML;
    // Offer rows honor the selection: the SAR listing is suppressed, the KWD
    // one stays.
    expect(html).toContain("Xcite");
    expect(html).not.toContain("Jarir");
    await act(async () => {
      fireEvent.click(pills[2]); // Saudi Arabia (SAR)
    });
    // Same-document filtering: the SAR-only view renders in place, the pill
    // moves its marker, and the URL echo follows without navigation.
    expect(document.body.innerHTML).toContain("Jarir");
    expect(document.body.innerHTML).not.toContain("Xcite");
    const pillsAfter = Array.from(
      document.querySelectorAll('nav[aria-label="Filter offers by country"] button'),
    );
    expect(pillsAfter[2].getAttribute("aria-current")).toBe("true");
    expect(window.location.search).toContain("c=SA");
    await act(async () => {
      fireEvent.click(pillsAfter[0]); // All
    });
    expect(document.body.innerHTML).toContain("Xcite");
    expect(document.body.innerHTML).toContain("Jarir");
  });

  it("the header search carries the active selection into the next query", async () => {
    searchParams.set("q", "airpods");
    searchParams.set("c", "KW");
    await act(async () => {
      render(<HeaderSearch />);
    });
    const hidden = document.querySelector('input[name="c"]');
    expect((hidden as HTMLInputElement | null)?.value).toBe("KW");
  });
});

describe("stock selection UI (REEA-186)", () => {
  const MIXED_STOCK: NormalizedProduct[] = [
    {
      productId: "sony-wh-1000xm6",
      title: "Sony WH-1000XM6",
      brand: "Sony",
      offers: [
        { merchant: "Xcite", price: 74, currency: "KWD", url: "https://xcite.example/p", inStock: true },
        { merchant: "Jarir", price: 69, currency: "SAR", url: "https://jarir.example/p", inStock: false },
      ],
      coupons: [],
      variations: [],
      alternatives: [],
    },
  ];

  beforeEach(() => {
    // Deterministic baseline: the shared mocked searchParams may carry the
    // country selection from the REEA-170 block above.
    searchParams.delete("oos");
    searchParams.delete("c");
    resetStockPrefs();
  });

  it("hides out-of-stock listings by default and shows the toggle unchecked", async () => {
    searchParams.set("q", "xm6");
    await act(async () => {
      render(<ResultsClient query="xm6" page={1} products={MIXED_STOCK} suggestions={MIXED_STOCK} />);
    });
    // Default: only the in-stock listing renders.
    const html = document.body.innerHTML;
    expect(html).toContain("Xcite");
    expect(html).not.toContain("Jarir");
    // Visible checkbox-style toggle, unchecked, in-place (REEA-291 AC4).
    const toggle = document.querySelector('[role="checkbox"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.textContent).toContain("Show out-of-stock items");
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
    // REEA-291 AC4: clicking flips the view against the loaded payload on the
    // client — no navigation, no refetch behind the selection change.
    await act(async () => {
      fireEvent.click(toggle as HTMLElement);
    });
    expect(document.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("true");
    expect(document.body.innerHTML).toContain("Jarir");
    expect(window.location.search).toContain("oos=1");
    await act(async () => {
      fireEvent.click(document.querySelector('[role="checkbox"]') as HTMLElement);
    });
    expect(document.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("false");
    expect(document.body.innerHTML).not.toContain("Jarir");
  });

  it("shows every listing while the toggle is checked, and unchecked hides again", async () => {
    searchParams.set("q", "xm6");
    searchParams.set("oos", "1");
    await act(async () => {
      render(
        <ResultsClient query="xm6" page={1} products={MIXED_STOCK} suggestions={MIXED_STOCK} showOutOfStock />,
      );
    });
    const html = document.body.innerHTML;
    expect(html).toContain("Xcite");
    expect(html).toContain("Jarir");
    const toggle = document.querySelector('[role="checkbox"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("true");
    // Unchecking filters the SAME loaded payload again — the hidden listings
    // drop without any request.
    await act(async () => {
      fireEvent.click(toggle as HTMLElement);
    });
    expect(document.querySelector('[role="checkbox"]')?.getAttribute("aria-checked")).toBe("false");
    expect(document.body.innerHTML).not.toContain("Jarir");
  });

  it("the header search carries the stock selection into the next query", async () => {
    searchParams.set("q", "xm6");
    searchParams.set("oos", "1");
    await act(async () => {
      render(<HeaderSearch />);
    });
    const hidden = document.querySelector('input[name="oos"]');
    expect((hidden as HTMLInputElement | null)?.value).toBe("1");
  });
});

describe("refresh action (REEA-291 AC4)", () => {
  const REFRESH_PRODUCTS: NormalizedProduct[] = [
    {
      productId: "sony-wh-1000xm6",
      title: "Sony WH-1000XM6",
      brand: "Sony",
      offers: [
        { merchant: "Xcite", price: 74, currency: "KWD", url: "https://xcite.example/p", inStock: true },
      ],
      coupons: [],
      variations: [],
      alternatives: [],
    },
  ];

  beforeEach(() => {
    searchParams.delete("oos");
    searchParams.delete("c");
    refreshSpy.mockClear();
  });

  it("the Refresh button re-runs the live collection; toggles stay in-place", async () => {
    searchParams.set("q", "xm6");
    await act(async () => {
      render(<ResultsClient query="xm6" page={1} products={REFRESH_PRODUCTS} suggestions={[]} />);
    });
    const refresh = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent === "Refresh",
    );
    expect(refresh).toBeDefined();
    await act(async () => {
      fireEvent.click(refresh as HTMLElement);
    });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
    // The one-shot refresh signal rides the very next request (REEA-291 AC4):
    // stamped at click so the server render re-collects live inside the
    // memo window and the collection timestamps move.
    expect(document.cookie).toContain("rc_refresh=1");
    // REEA-439 — the request rides a UNIQUE `_r` stamp so the bounded shared
    // window can never answer the Refresh: guaranteed miss, newer scrapedAt.
    expect(String(refreshSpy.mock.calls[0][0])).toContain("_r=");
    // Selection changes on the same view never go through the router either.
    const toggle = document.querySelector('[role="checkbox"]') as HTMLElement;
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });
});

describe("staged progressive results (REEA-178)", () => {
  const STAGE1_PRODUCT: NormalizedProduct = {
    productId: "sony-wh-1000xm6",
    title: "Sony WH-1000XM6",
    brand: "Sony",
    offers: [
      { merchant: "Xcite", price: 74, currency: "KWD", url: "https://xcite.example/p", inStock: true },
    ],
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: new Date().toISOString(),
  };
  const FINAL_PRODUCT_B: NormalizedProduct = {
    productId: "sony-wh-ch720n",
    title: "Sony WH-CH720N",
    brand: "Sony",
    offers: [
      { merchant: "Blink", price: 40, currency: "KWD", url: "https://blink.example/ch720n", inStock: true },
    ],
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: new Date().toISOString(),
  };
  // Converged snapshot: Xcite + Blink offers merged into the XM6 card.
  const FINAL_MERGED_A: NormalizedProduct = {
    ...STAGE1_PRODUCT,
    offers: [
      { merchant: "Blink", price: 60, currency: "KWD", url: "https://blink.example/xm6", inStock: true },
      ...STAGE1_PRODUCT.offers,
    ],
  };

  it("paints stage-one offers before later stages resolve, then converges", async () => {
    searchParams.set("q", "sony");
    searchParams.delete("oos");
    searchParams.delete("c");
    let resolveFinal: (v: LiveSearchResult) => void = () => {};
    const stageOne: LiveSearchResult = { products: [STAGE1_PRODUCT], notes: [], suggestions: [STAGE1_PRODUCT] };
    const stages: Promise<LiveSearchResult>[] = [
      Promise.resolve(stageOne),
      new Promise<LiveSearchResult>((res) => {
        resolveFinal = res;
      }),
    ];

    await act(async () => {
      render(
        <ResultsClient query="sony" page={1} country={null} stages={stages} />,
      );
    });

    // AC-1: the first flush is already visible while the later stage is pending.
    let html = document.body.innerHTML;
    expect(html).toContain("Sony WH-1000XM6");
    expect(html).not.toContain("Sony WH-CH720N");
    // Count heading + funnel events wait for the converged set.
    expect(document.body.textContent).not.toContain("results for");
    expect(eventsSent().some((e) => e.type === "search_submitted")).toBe(false);

    await act(async () => {
      resolveFinal({ products: [FINAL_MERGED_A, FINAL_PRODUCT_B], notes: [], suggestions: [] });
      await Promise.resolve();
    });

    html = document.body.innerHTML;
    expect(html).toContain("Sony WH-CH720N");
    // Converged view: full count heading with the merged 2-result set.
    expect(document.body.textContent).toContain("2 results for");
    // REEA-382 AC-1 — the heading number equals the rendered card count in
    // the same markup: two products, exactly two article.result-card
    // elements. The heading reading the FINAL snapshot (not stage zero) is
    // what keeps the served document self-consistent under append-only
    // flushes at the nineteen-store row counts.
    expect(document.querySelectorAll("article.result-card")).toHaveLength(2);

    const evts = eventsSent();
    const search = evts.find((e) => e.type === "search_submitted");
    expect(search?.result_count).toBe(2);
  });

  it("REEA-222: the streaming shell keeps exactly one Best-price badge when early flushes render nothing", async () => {
    // Live repro: `Case for iPhone 17 Pro` answered with an empty first
    // snapshot — every later flush used to render badge-less because only
    // index 0 could own the badge. Badge ownership now follows the first
    // flush that actually renders cards.
    searchParams.set("q", "Case for iPhone 17 Pro");
    searchParams.delete("oos");
    searchParams.delete("c");
    const CASE_A: NormalizedProduct = {
      productId: "panzer-magsafe-slim",
      title: "Panzer Care MagSafe Slim Case for iPhone 17 Pro",
      brand: "",
      offers: [{ merchant: "Blink", price: 6.9, currency: "KWD", url: "https://blink.example/p1", inStock: true }],
      coupons: [],
      variations: [],
      alternatives: [],
      scrapedAt: new Date().toISOString(),
    };
    const CASE_B: NormalizedProduct = {
      productId: "amazing-thing-folio",
      title: "Amazing Thing Glamour Folio Flip Cover for iPhone 17 Pro",
      brand: "",
      offers: [{ merchant: "Xcite", price: 11.342, currency: "KWD", url: "https://xcite.example/p2", inStock: true }],
      coupons: [],
      variations: [],
      alternatives: [],
      scrapedAt: new Date().toISOString(),
    };
    const stages: Promise<LiveSearchResult>[] = [
      // Flush 0: the first retailer answered with nothing visible under the
      // current selections — renders no cards.
      Promise.resolve({ products: [], notes: [], suggestions: [] }),
      Promise.resolve({ products: [CASE_A, CASE_B], notes: [], suggestions: [] }),
      // Later flush still pending: the view is the streamed shell, exactly
      // what a no-JS client sees.
      new Promise<LiveSearchResult>(() => {}),
    ];

    await act(async () => {
      render(
        <ResultsClient query="Case for iPhone 17 Pro" page={1} country={null} stages={stages} />,
      );
    });

    const flags = document.querySelectorAll(".best-flag");
    expect(flags).toHaveLength(1);
    // The badge rides the first stocked card of the rendered block.
    expect(flags[0].closest("article")?.textContent).toContain("Panzer Care MagSafe Slim");
  });
});

describe("relevance tiering + brand hygiene (REEA-189)", () => {
  const DEVICE_A: NormalizedProduct = {
    productId: "galaxy-buds3-pro",
    title: "Samsung Galaxy Buds3 Pro",
    brand: "Samsung",
    offers: [{ merchant: "Xcite", price: 60, currency: "KWD", url: "https://xcite.example/buds3", inStock: true }],
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-09-07T00:00:00.000Z",
  };
  const DEVICE_B: NormalizedProduct = {
    productId: "galaxy-buds-fe",
    title: "Samsung Galaxy Buds FE",
    brand: "Samsung",
    offers: [{ merchant: "Jarir", price: 45, currency: "SAR", url: "https://jarir.example/budsfe", inStock: true }],
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-09-07T00:00:00.000Z",
  };
  const ACCESSORY: NormalizedProduct = {
    productId: "ringke-case",
    title: "RINGKE Onyx Earbuds Case",
    brand: "RINGKE",
    offers: [{ merchant: "Xcite", price: 8, currency: "KWD", url: "https://xcite.example/ringke", inStock: true }],
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: "2026-09-07T00:00:00.000Z",
  };

  it("stacks devices above accessories on device-intent queries", async () => {
    searchParams.set("q", "samsung galaxy buds");
    searchParams.delete("oos");
    searchParams.delete("c");
    await act(async () => {
      render(
        <ResultsClient query="samsung galaxy buds" page={1} products={[DEVICE_A, ACCESSORY, DEVICE_B]} suggestions={[]} />,
      );
    });
    const html = document.body.innerHTML;
    expect(html).toContain('aria-label="Devices"');
    expect(html).toContain('aria-label="Accessories"');
    // AC-1: every device card sits above the accessory block.
    expect(html.indexOf("Galaxy Buds FE")).toBeLessThan(html.indexOf("RINGKE Onyx"));
    const devices = document.querySelector('[aria-label="Devices"]');
    const accessories = document.querySelector('[aria-label="Accessories"]');
    expect(devices?.textContent).toContain("Galaxy Buds3 Pro");
    expect(devices?.textContent).toContain("Galaxy Buds FE");
    expect(accessories?.textContent).toContain("RINGKE Onyx Earbuds Case");
  });

  it("keeps the plain single list for non-device queries", async () => {
    searchParams.set("q", "ceramic mug");
    await act(async () => {
      render(
        <ResultsClient query="ceramic mug" page={1} products={[{ ...DEVICE_A, productId: "mug", title: "Ceramic Mug White" }]} suggestions={[]} />,
      );
    });
    expect(document.querySelector('[aria-label="Devices"]')).toBeNull();
    expect(document.body.innerHTML).toContain("Ceramic Mug White");
  });

  it("renders no brand chip when resolution leaves the brand empty", async () => {
    searchParams.set("q", "sony");
    await act(async () => {
      render(
        <ResultsClient query="sony" page={1} products={[{ ...DEVICE_A, brand: "" }]} suggestions={[]} />,
      );
    });
    expect(document.body.innerHTML).toContain("Galaxy Buds3 Pro");
    expect((document.body.innerHTML.match(/label-token inline-flex/g) ?? []).length).toBe(0);
  });
});

describe("zero-result state category links (REEA-281 AC-3)", () => {
  it("shows at least 3 clickable category links with no suggestions at all", async () => {
    searchParams.set("q", "zzzqqqnothing");
    await act(async () => {
      render(
        <ResultsClient query="zzzqqqnothing" page={1} products={[]} suggestions={[]} />,
      );
    });
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("div.result-card a.query-pill"));
    expect(links.length).toBeGreaterThanOrEqual(3);
    // Every pill is a working onward path: a results query link.
    for (const a of links) expect(a.getAttribute("href")).toMatch(/^\/results\?q=/);
  });

  it("still reaches 3 links when the relaxed collection returns one suggestion", async () => {
    searchParams.set("q", "zzzqqqnothing");
    await act(async () => {
      render(
        <ResultsClient query="zzzqqqnothing" page={1} products={[]} suggestions={[SAMPLE_PRODUCTS[0]]} />,
      );
    });
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("div.result-card a.query-pill"));
    expect(links.length).toBeGreaterThanOrEqual(3);
    // The live suggestion leads; categories pad the rest.
    expect(links[0].textContent).toBe(SAMPLE_PRODUCTS[0].title);
    for (const c of ["Smartphones", "Fragrances", "Kitchen appliances"]) {
      expect(links.some((a) => a.textContent === c)).toBe(true);
    }
  });

  it("keeps all 3 category links even when the relaxed collection returns a full pill row", async () => {
    // AC-3 is a floor on CATEGORY links, not just pills: a query that
    // zeroed out but still yielded live suggestions must not trade the
    // broad onward paths away for product-title pills.
    searchParams.set("q", "zzzqqqnothing");
    const many = ["Sony WH-1000XM6", "Anker PowerCore", "JBL Tune 720BT"].map(
      (title, i): NormalizedProduct => ({ ...SAMPLE_PRODUCTS[0], productId: `s${i}`, title }),
    );
    await act(async () => {
      render(
        <ResultsClient query="zzzqqqnothing" page={1} products={[]} suggestions={many} />,
      );
    });
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("div.result-card a.query-pill"));
    // Suggestions ride first, then the three category links — deduped.
    expect(links[0].textContent).toBe("Sony WH-1000XM6");
    const texts = links.map((a) => a.textContent);
    for (const c of ["Smartphones", "Fragrances", "Kitchen appliances"]) {
      expect(texts.filter((t) => t === c)).toHaveLength(1);
    }
    expect(links.length).toBeGreaterThanOrEqual(3);
  });
});

describe("coverage line (REEA-290)", () => {
  it("names the missing retailer in plain text while other retailers' offers keep rendering", async () => {
    searchParams.set("q", "sony");
    searchParams.delete("oos");
    searchParams.delete("c");
    const PRODUCT: NormalizedProduct = {
      productId: "sony-wh-1000xm6",
      title: "Sony WH-1000XM6",
      brand: "Sony",
      offers: [
        { merchant: "Xcite", price: 74, currency: "KWD", url: "https://xcite.example/p", inStock: true },
      ],
      coupons: [],
      variations: [],
      alternatives: [],
      scrapedAt: "2026-09-08T00:00:00.000Z",
    };
    const snap: LiveSearchResult = {
      products: [PRODUCT],
      notes: [
        { merchant: "Xcite", hits: 2 },
        { merchant: "Jarir", hits: 0, error: "HTTP 403" },
      ],
      suggestions: [PRODUCT],
    };
    await act(async () => {
      render(
        <ResultsClient query="sony" page={1} country={null} stages={[Promise.resolve(snap), Promise.resolve(snap)]} />,
      );
    });
    const html = document.body.innerHTML;
    // The failing retailer is named on the page…
    expect(html).toContain("No response from Jarir.");
    // …while the responding retailer's live offer still renders beside it.
    expect(html).toContain("Prices from Xcite.");
    expect(html).toContain("Sony WH-1000XM6");
  });

  it("keeps the coverage line out of an all-answered plain snapshot only when notes are empty", async () => {
    searchParams.set("q", "sony");
    searchParams.delete("oos");
    searchParams.delete("c");
    const snap: LiveSearchResult = { products: SAMPLE_PRODUCTS, notes: [], suggestions: SAMPLE_PRODUCTS };
    await act(async () => {
      render(
        <ResultsClient query="sony" page={1} country={null} stages={[Promise.resolve(snap)]} />,
      );
    });
    // Nothing collected yet is not a coverage story — no empty stamp lands.
    expect(document.body.innerHTML).not.toContain("No response from");
  });

  it("REEA-601 — the streamed stamp names exactly the merchants whose rows the flushed blocks painted", async () => {
    // The fork this guards: stage one paints A (Xcite) + B (Blink); the final
    // stage re-ranks so far that A falls out of the page slice, but its card
    // STAYS above the fold of the streamed markup (append-only blocks). A
    // stamp read off the final snapshot alone loses A's merchant (missing
    // name) while keeping whatever the final slice holds (phantom trailing
    // names). The served stamp must match the rows actually rendered — the
    // union the shopper sees before hydration converges.
    searchParams.set("q", "sony");
    searchParams.delete("oos");
    searchParams.delete("c");
    const row = (id: string, merchant: string, price: number): NormalizedProduct => ({
      productId: id,
      title: `${id} title`,
      brand: id,
      offers: [{ merchant, price, currency: "KWD", url: `https://${merchant}.example/p`, inStock: true }],
      coupons: [],
      variations: [],
      alternatives: [],
      scrapedAt: "2026-09-11T00:00:00.000Z",
    });
    const stageOne: LiveSearchResult = {
      products: [row("a", "Xcite", 100), row("b", "Blink", 90)],
      notes: [
        { merchant: "Xcite", hits: 1 },
        { merchant: "Blink", hits: 1 },
      ],
      suggestions: [],
    };
    // Final stage: 20 filler rows from Jarir re-rank B to the top and push A
    // past the PAGE_SIZE slice — its streamed card remains, though.
    const fillers = Array.from({ length: 20 }, (_, i) => row(`f${i}`, "Jarir", 80 + i));
    const finalSnap: LiveSearchResult = {
      products: [row("b", "Blink", 90), ...fillers],
      notes: [
        { merchant: "Xcite", hits: 1 },
        { merchant: "Blink", hits: 1 },
        { merchant: "Jarir", hits: 20 },
      ],
      suggestions: [],
    };
    // The SERVED streamed document (async SSR): boundaries flush as their
    // snapshots resolve, so the markup is exactly the append-only union of
    // the stage blocks — what the shopper reads before hydration converges.
    // (renderToString would serialize only the pending fallbacks; the client
    // render converges onto the final slice, which is REEA-574 R1 territory.)
    const stream = await renderToReadableStream(
      <ResultsClient
        query="sony"
        page={1}
        country={null}
        locale="en"
        stages={[Promise.resolve(stageOne), Promise.resolve(finalSnap)]}
      />,
    );
    let html = "";
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
    }
    // Union of painted rows, fixed adapter order: Xcite (block one), Blink and
    // Jarir (later blocks) — every named merchant has ≥1 row in this markup.
    expect(html).toContain("Prices from Xcite, Blink and Jarir.");
    // A merchant answered-but-displaced must not survive into the stamp…
    expect(html).not.toContain("Prices from Jarir, Blink.");
    // …and A's painted row keeps its name beside it.
    expect(html).toContain("a title");
  });
});

describe("empty-state hint line (REEA-332 item 2)", () => {
  const HINT = "No matches — try a shorter phrase.";

  it("shows one hint line under the count heading when the answer is empty", async () => {
    searchParams.set("q", "zzxwq kvqpl");
    await act(async () => {
      render(
        <ResultsClient query="zzxwq kvqpl" page={1} products={[]} suggestions={[]} />,
      );
    });
    const heading = document.querySelector("h1");
    expect(heading?.textContent).toContain("zzxwq kvqpl");
    // The hint rides DIRECTLY under the count heading…
    const hint = heading?.nextElementSibling;
    expect(hint?.tagName).toBe("P");
    expect(hint?.textContent).toBe(HINT);
    // …in the stated treatment: small text, muted colour.
    expect(hint?.getAttribute("style")).toContain("font: var(--rc-text-small)");
    expect(hint?.getAttribute("style")).toContain("color: var(--rc-muted)");
  });

  it("keeps heading + hint through staged convergence — one heading, hint under it", async () => {
    searchParams.set("q", "zzxwq");
    searchParams.delete("oos");
    searchParams.delete("c");
    const emptySnap: LiveSearchResult = { products: [], notes: [], suggestions: [] };
    await act(async () => {
      render(
        <ResultsClient query="zzxwq" page={1} country={null} stages={[Promise.resolve(emptySnap), Promise.resolve(emptySnap)]} />,
      );
    });
    // Converged: the heading from the streamed shell stays (REEA-224 geometry),
    // exactly one h1, hint line beneath it, then the empty-state card.
    const headings = document.querySelectorAll("h1");
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toContain("zzxwq");
    expect(headings[0].nextElementSibling?.textContent).toBe(HINT);
    expect(document.body.textContent).toContain("No matches for “zzxwq” yet");
  });

  it("shows no hint once the query matched something", async () => {
    searchParams.set("q", "sony");
    await act(async () => {
      render(
        <ResultsClient query="sony" page={1} products={SAMPLE_PRODUCTS} suggestions={SAMPLE_PRODUCTS} />,
      );
    });
    expect(document.body.textContent).toContain("1 result for");
    expect(document.body.textContent).not.toContain(HINT);
  });
});

describe("cold-start zero handling (REEA-437)", () => {
  const FINALIZED_EMPTY: LiveSearchResult = {
    products: [],
    notes: [
      { merchant: "Xcite", hits: 0, error: "no answer within the 4500 ms completion budget" },
    ],
    settled: false,
  };

  it("keeps the heading skeleton (no zero-count flash) while the finalized page still deepens", async () => {
    searchParams.set("q", "wh-1000xm6");
    searchParams.delete("oos");
    searchParams.delete("c");
    let resolveFeed: (v: unknown) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFeed = resolve;
          }),
      ),
    );
    await act(async () => {
      render(
        <ResultsClient
          query="wh-1000xm6"
          page={1}
          country={null}
          stages={[Promise.resolve(FINALIZED_EMPTY), Promise.resolve(FINALIZED_EMPTY)]}
        />,
      );
    });
    // Provisional zero: skeleton heading instead of a flashing "0 results".
    // REEA-574 rev 1 (R1): nothing is rendered yet, so the coverage sentence
    // stays hidden too — the empty page state shows heading + hint + empty
    // state only, and the line lands with the first rendered rows.
    expect(document.querySelector("h1")).toBeNull();
    expect(document.body.textContent).not.toContain("No response from");
    // The follow-up feed lands the converged live answer — heading + cards.
    const late: LiveSearchResult = { products: SAMPLE_PRODUCTS, notes: [], suggestions: SAMPLE_PRODUCTS };
    await act(async () => {
      resolveFeed({ ok: true, json: async () => late });
    });
    const heading = document.querySelector("h1");
    expect(heading?.textContent).toContain("wh-1000xm6");
    expect(document.body.textContent).toContain("Sony WH-1000XM6");
  });

  it("names the query forms the widened retry tried once the answer is honestly zero", async () => {
    searchParams.set("q", "lg gram mini");
    searchParams.delete("oos");
    searchParams.delete("c");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => null })),
    );
    const emptySnap: LiveSearchResult = {
      products: [],
      notes: [],
      suggestions: [],
      attemptedQueries: ["lg gram mini", "lg gram"],
    };
    await act(async () => {
      render(
        <ResultsClient
          query="lg gram mini"
          page={1}
          country={null}
          stages={[Promise.resolve(emptySnap), Promise.resolve(emptySnap)]}
        />,
      );
    });
    // Empty state after BOTH forms answered zero, naming what was tried.
    expect(document.body.textContent).toContain("No matches for “lg gram mini” yet");
    expect(document.body.textContent).toContain("We searched “lg gram mini”, “lg gram”.");
  });
});

describe("collecting busy state on the pulse-bar rail (REEA-447 R1)", () => {
  it("ships aria-busy in the served markup while collecting", () => {
    // Served (pre-hydration) markup: the rail exists precisely while the
    // staged boundary is still collecting, and carries the busy state.
    const html = renderToStaticMarkup(<LoadingFallback locale="en" />);
    expect(html).toContain('class="pulse-bar"');
    expect(html).toContain('aria-busy="true"');
  });

  it("drops aria-busy once the shell has settled", async () => {
    // Hydrated pass: the settling flip removes the attribute (undefined
    // omits it), so the busy signal never outlives the collection — and the
    // settled view itself never re-mounts the rail. Async act drains the
    // one-tick settle before the assertions run.
    await act(async () => {
      render(<LoadingFallback locale="en" />);
    });
    const bar = document.querySelector(".pulse-bar");
    expect(bar).not.toBeNull();
    expect(bar?.getAttribute("aria-busy")).toBeNull();
  });
});


describe("REEA-721 QA item5 — honest empty in the SERVED streamed document", () => {
  const drain = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    let html = "";
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
    }
    return html;
  };

  it("streams the zero heading + hint once the final snapshot settles at zero", async () => {
    searchParams.set("q", "zzxwq");
    searchParams.delete("oos");
    searchParams.delete("c");
    const zeroSnap: LiveSearchResult = { products: [], notes: [], suggestions: [], settled: true };
    const stream = await renderToReadableStream(
      <ResultsClient query="zzxwq" page={1} country={null} locale="en" stages={[Promise.resolve(zeroSnap), Promise.resolve(zeroSnap)]} />,
    );
    const html = await drain(stream);
    // QA grade item 5: the delivered document itself states the honest zero —
    // count heading plus its hint line — not only the filter row over space.
    expect(html).toContain("zzxwq");
    expect(html).toContain("No matches — try a shorter phrase.");
  });

  it("keeps the skeleton while a finalized-at-budget zero is still provisional", async () => {
    searchParams.set("q", "zzxwq");
    searchParams.delete("oos");
    searchParams.delete("c");
    const provisional: LiveSearchResult = { products: [], notes: [], suggestions: [], settled: false };
    const stream = await renderToReadableStream(
      <ResultsClient query="zzxwq" page={1} country={null} locale="en" stages={[Promise.resolve(provisional), Promise.resolve(provisional)]} />,
    );
    const html = await drain(stream);
    // REEA-437 semantics hold: a zero that may still deepen behind the
    // response keeps the skeleton until the follow-up feed answers.
    expect(html).not.toContain("No matches — try a shorter phrase.");
  });
});

/* REEA-778 check 2 — the heading/stamp reserves paint from the FIRST streamed
   flush: the served document itself carries the heading-slot block and the
   coverage-line lh-tier box, so heading/stamp swap IN-TO their slots instead
   of pushing the already-painted card grid down (~79px on the old head). */
describe("first-flush reserves (REEA-778)", () => {
  const PENDING: Promise<LiveSearchResult> = new Promise(() => {});

  it("inlines heading-slot + coverage-line reserves into the streamed shell", () => {
    const html = renderToStaticMarkup(
      <ResultsClient query="iPhone 17 Pro" page={1} country={null} stages={[PENDING]} locale="en" />,
    );
    expect(html).toContain("heading-slot skeleton-block");
    expect(html).toContain('class="meta-stamp coverage-line"');
  });

  it("sizes the coverage-line reserve on the locale lh tier (EN 1lh, AR 2lh)", () => {
    const en = renderToStaticMarkup(<LoadingFallback locale="en" />);
    const ar = renderToStaticMarkup(<LoadingFallback locale="ar" />);
    expect(en).toContain('class="meta-stamp coverage-line"');
    expect(en).toContain("min-height:1lh");
    expect(ar).toContain("min-height:2lh");
  });
});
