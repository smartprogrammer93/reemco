import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { generateMetadata as productMetadata } from "@/app/product/[productId]/page";
import { generateMetadata as resultsMetadata } from "@/app/results/page";
import { generateMetadata as searchMetadata } from "@/app/search/page";
import * as robotsModule from "@/app/robots";
import * as sitemapModule from "@/app/sitemap";
import {
  SITEMAP_QUERY_SEEDS,
  queriesWithResults,
  selectSitemapQueries,
} from "@/lib/sitemap-queries";
import type { FunnelEvent } from "@/lib/events";

/**
 * REEA-278 / REEA-1168 — guardrails for the metadata route handlers. These
 * prove the acceptance shape without a server: robots names the sitemap and
 * stays crawl-open; the sitemap lists the core pages, ≥10 live query URLs and
 * ≥10 stable product URLs, all absolute and all on the /results canonical
 * shape (never the /search duplicate).
 */
describe("robots route handler (/robots.txt)", () => {
  it("opens the site to all crawlers and references the sitemap", () => {
    const out = robots();
    expect(out.rules).toMatchObject({ userAgent: "*", allow: "/" });
    expect(out.sitemap).toBe("https://ns539626.ip-144-217-72.net/sitemap.xml");
  });
});

describe("sitemap route handler (/sitemap.xml)", () => {
  it("lists the core pages, ≥10 query URLs and ≥10 product URLs as absolute URLs", async () => {
    const urls = (await sitemap()).map((entry) => entry.url);
    expect(urls).toContain("https://ns539626.ip-144-217-72.net");
    expect(urls).toContain("https://ns539626.ip-144-217-72.net/about");
    expect(urls).toContain("https://ns539626.ip-144-217-72.net/privacy");
    expect(urls).toContain("https://ns539626.ip-144-217-72.net/contact");
    // REEA-1168 AC-2 — the long-tail query set is at least ten URLs.
    expect(urls.filter((u) => /^https:\/\/ns539626\.ip-144-217-72\.net\/results\?q=\S/.test(u)).length)
      .toBeGreaterThanOrEqual(10);
    // Stable product identities from the feed.
    expect(urls.filter((u) => /^https:\/\/ns539626\.ip-144-217-72\.net\/product\/[^/?#]+$/.test(u)).length)
      .toBeGreaterThanOrEqual(10);
    // /search?q= is the duplicate address; only /results?q= is listed.
    expect(urls.some((u) => u.includes("/search?q="))).toBe(false);
    // Every entry is absolute — relative URLs break XML sitemap validation.
    expect(urls.every((u) => /^https:\/\//.test(u))).toBe(true);
    // The curated preset pills are always present, even when the funnel store
    // is empty (the QA anchor queries).
    for (const query of SITEMAP_QUERY_SEEDS.slice(0, 3)) {
      expect(urls).toContain(
        `https://ns539626.ip-144-217-72.net/results?q=${encodeURIComponent(query)}`,
      );
    }
  });
});

describe("results canonical shape (REEA-1168 AC-3)", () => {
  it("the results surface advertises /results?q= with the same encoding as internal links", async () => {
    const meta = await resultsMetadata({
      searchParams: Promise.resolve({ q: "iphone 17 pro" }),
    });
    expect(meta.alternates?.canonical).toBe(
      "https://ns539626.ip-144-217-72.net/results?q=iphone%2017%20pro",
    );
    // No noindex on an indexable query surface.
    expect(meta.robots).toBeUndefined();
  });

  it("the /search duplicate points its canonical at /results?q=", async () => {
    const meta = await searchMetadata({
      searchParams: Promise.resolve({ q: "iphone 17 pro" }),
    });
    expect(meta.alternates?.canonical).toBe(
      "https://ns539626.ip-144-217-72.net/results?q=iphone%2017%20pro",
    );
  });
});

describe("crawler routes follow the serving host (REEA-1051)", () => {
  const previous = process.env.REEMCO_SITE_ORIGIN;
  async function withOrigin<T>(origin: string, run: () => Promise<T>): Promise<T> {
    process.env.REEMCO_SITE_ORIGIN = origin;
    try {
      return await run();
    } finally {
      if (previous === undefined) delete process.env.REEMCO_SITE_ORIGIN;
      else process.env.REEMCO_SITE_ORIGIN = previous;
    }
  }

  it("robots names the sitemap on the self-hosted box, not the Vercel alias", () => {
    expect(robots().sitemap).toBe("https://ns539626.ip-144-217-72.net/sitemap.xml");
  });

  it("sitemap URLs all ride the configured origin", async () => {
    await withOrigin("https://ns539626.ip-144-217-72.net", async () => {
      const urls = (await sitemap()).map((entry) => entry.url);
      expect(urls.every((u) => u.startsWith("https://ns539626.ip-144-217-72.net"))).toBe(true);
      expect(urls.some((u) => u.includes("reemco.vercel.app"))).toBe(false);
    });
  });

  it("both handlers opt out of build-time caching so the runtime origin wins", () => {
    // Metadata routes are prerendered at build by default. Without the
    // force-dynamic segment config the origin is baked into the artifact from
    // build-time env (the regression measured on the box: sitemap still named
    // the Vercel alias after the runtime env was set).
    expect(sitemapModule.dynamic).toBe("force-dynamic");
    expect(robotsModule.dynamic).toBe("force-dynamic");
  });
});

describe("sitemap query eligibility (REEA-1189)", () => {
  const now = Date.parse("2026-11-26T03:00:00.000Z");
  function event(
    query: string,
    count: number,
    minutesAgo: number,
  ): FunnelEvent {
    return {
      id: `${query}-${minutesAgo}`,
      ts: new Date(now - minutesAgo * 60 * 1000).toISOString(),
      type: "search_submitted",
      query,
      result_count: count,
    };
  }

  it("keeps only queries whose latest search returned a result", () => {
    const indexable = queriesWithResults(
      [
        event("iphone 17 pro", 4, 30),
        event("zzzz-not-a-product-1156", 0, 20),
        event("zzqx plumbus 9000", 0, 10),
        // A query that recovered: the latest stamp wins.
        event("coffee machine", 0, 60),
        event("coffee machine", 3, 5),
        // Outside the 24 h window does not count.
        event("old query", 0, 60 * 30),
      ],
      now,
    );
    expect(indexable.has("iphone 17 pro")).toBe(true);
    expect(indexable.has("coffee machine")).toBe(true);
    expect(indexable.has("zzzz-not-a-product-1156")).toBe(false);
    expect(indexable.has("zzqx plumbus 9000")).toBe(false);
    expect(indexable.has("old query")).toBe(false);
  });

  it("always keeps curated seeds and drops zero-result trending queries", () => {
    const indexable = queriesWithResults(
      [event("zzqx plumbus 9000", 0, 5), event("air fryer", 2, 5)],
      now,
    );
    const queries = selectSitemapQueries(
      ["iPhone 17 Pro", "panadol"],
      ["zzqx plumbus 9000", "air fryer", "iPhone 17 Pro"],
      indexable,
    );
    expect(queries).toEqual(["iPhone 17 Pro", "panadol", "air fryer"]);
  });

  it("fail-open (null indexable set) keeps the curated and trending order", () => {
    expect(
      selectSitemapQueries(["iPhone 17 Pro"], ["coffee machine"], null),
    ).toEqual(["iPhone 17 Pro", "coffee machine"]);
  });
});

describe("product page canonical + title (REEA-1189)", () => {
  it("seeded catalog ids self-canonicalize with a product-specific title", async () => {
    const meta = await productMetadata({
      params: Promise.resolve({ productId: "iphone-17-pro" }),
      searchParams: Promise.resolve({}),
    });
    expect(meta.alternates?.canonical).toBe(
      "https://ns539626.ip-144-217-72.net/product/iphone-17-pro",
    );
    expect(String(meta.title)).toContain("Apple iPhone 17 Pro 256GB");
    expect(String(meta.description)).toContain("Apple iPhone 17 Pro 256GB");
  });

  it("a live merge slug folds onto the one catalog canonical", async () => {
    const meta = await productMetadata({
      params: Promise.resolve({ productId: "apple-iphone17-pro-256gb" }),
      searchParams: Promise.resolve({}),
    });
    expect(meta.alternates?.canonical).toBe(
      "https://ns539626.ip-144-217-72.net/product/iphone-17-pro",
    );
    expect(String(meta.title)).toContain("Apple iPhone 17 Pro 256GB");
  });

  it("a live-only SKU keeps its own canonical and a readable title", async () => {
    const meta = await productMetadata({
      params: Promise.resolve({ productId: "apple-iphone17-pro-512gb" }),
      searchParams: Promise.resolve({}),
    });
    expect(meta.alternates?.canonical).toBe(
      "https://ns539626.ip-144-217-72.net/product/apple-iphone17-pro-512gb",
    );
    expect(String(meta.title)).toContain("Apple iPhone 17 Pro 512GB");
  });
});
