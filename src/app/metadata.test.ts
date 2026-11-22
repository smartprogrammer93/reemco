import { describe, expect, it } from "vitest";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";

/**
 * REEA-278 — guardrails for the metadata route handlers. These prove the
 * acceptance shape of the two endpoints without a server: robots names the
 * sitemap and stays crawl-open; the sitemap lists the four core pages plus
 * top-query result pages, all as absolute URLs.
 */
describe("robots route handler (/robots.txt)", () => {
  it("opens the site to all crawlers and references the sitemap", () => {
    const out = robots();
    expect(out.rules).toMatchObject({ userAgent: "*", allow: "/" });
    expect(out.sitemap).toBe("https://reemco.vercel.app/sitemap.xml");
  });
});

describe("sitemap route handler (/sitemap.xml)", () => {
  it("lists the core pages and top-query result pages as absolute URLs", () => {
    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toContain("https://reemco.vercel.app");
    expect(urls).toContain("https://reemco.vercel.app/about");
    expect(urls).toContain("https://reemco.vercel.app/privacy");
    expect(urls).toContain("https://reemco.vercel.app/contact");
    // Top-query result pages use the live /results?q= shape.
    expect(urls.filter((u) => /^https:\/\/reemco\.vercel\.app\/results\?q=\S/.test(u)).length)
      .toBeGreaterThanOrEqual(3);
    // Every entry is absolute — relative URLs break XML sitemap validation.
    expect(urls.every((u) => /^https:\/\//.test(u))).toBe(true);
  });
});

describe("crawler routes follow the serving host (REEA-1051)", () => {
  const previous = process.env.REEMCO_SITE_ORIGIN;
  function withOrigin<T>(origin: string, run: () => T): T {
    process.env.REEMCO_SITE_ORIGIN = origin;
    try {
      return run();
    } finally {
      if (previous === undefined) delete process.env.REEMCO_SITE_ORIGIN;
      else process.env.REEMCO_SITE_ORIGIN = previous;
    }
  }

  it("robots names the sitemap on the self-hosted box, not the Vercel alias", () => {
    withOrigin("https://ns539626.ip-144-217-72.net", () => {
      expect(robots().sitemap).toBe("https://ns539626.ip-144-217-72.net/sitemap.xml");
    });
  });

  it("sitemap URLs all ride the configured origin", () => {
    withOrigin("https://ns539626.ip-144-217-72.net", () => {
      const urls = sitemap().map((entry) => entry.url);
      expect(urls.every((u) => u.startsWith("https://ns539626.ip-144-217-72.net"))).toBe(true);
      expect(urls.some((u) => u.includes("reemco.vercel.app"))).toBe(false);
    });
  });
});
