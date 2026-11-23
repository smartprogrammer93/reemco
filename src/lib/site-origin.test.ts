/**
 * REEA-1051 / REEA-1076 — crawler-facing canonical origin must follow the
 * serving host.
 *
 * /sitemap.xml and /robots.txt used to name the Vercel alias literally, which
 * on the self-hosted box pointed every crawler-learned URL at the 402 rollback
 * host. The origin is now REEMCO_SITE_ORIGIN-driven; since the Vercel
 * decommission the compiled-in fallback is the production host.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SITE_ORIGIN, siteOrigin } from "@/lib/site-origin";

describe("siteOrigin (REEA-1051)", () => {
  it("defaults to the production host, never the retired Vercel alias", () => {
    expect(DEFAULT_SITE_ORIGIN).toBe("https://ns539626.ip-144-217-72.net");
    expect(siteOrigin({})).toBe(DEFAULT_SITE_ORIGIN);
    expect(siteOrigin({ REEMCO_SITE_ORIGIN: "   " })).toBe(DEFAULT_SITE_ORIGIN);
  });

  it("uses the configured serving host (the self-hosted box shape)", () => {
    expect(siteOrigin({ REEMCO_SITE_ORIGIN: "https://ns539626.ip-144-217-72.net" })).toBe(
      "https://ns539626.ip-144-217-72.net",
    );
    // A cutover domain with a path/trailing slash normalizes to its origin.
    expect(siteOrigin({ REEMCO_SITE_ORIGIN: "https://reemco.example.com/" })).toBe(
      "https://reemco.example.com",
    );
  });

  it("rejects unusable values instead of emitting a broken absolute URL", () => {
    expect(siteOrigin({ REEMCO_SITE_ORIGIN: "not a url" })).toBe(DEFAULT_SITE_ORIGIN);
    expect(siteOrigin({ REEMCO_SITE_ORIGIN: "ftp://reemco.example.com" })).toBe(DEFAULT_SITE_ORIGIN);
  });
});
