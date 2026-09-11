// @vitest-environment jsdom
/**
 * REEA-510 — labeled last-seen fallback when a retailer live pass returns empty.
 *
 * Covers the acceptance shape: live hits keep the snapshot entirely out of the
 * served set; a silent live pass fills its column from the retailer+query
 * snapshot with the original collection stamps and the fromSnapshot marker;
 * snapshots older than 24 h are dropped on read; a fresh live answer replaces
 * the fallback automatically (its own round rewrites the snapshot); the row
 * ladder keeps snapshot rows below every live row; and the fixed query set
 * (EN + AR) shows the visible-column improvement over five sequential runs.
 * The degraded disk layer is exercised with the CI-parity env (KV vars empty);
 * the shared KV binding itself is covered by kv-store.test.ts's REST emulation.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchHit } from "@/lib/collect/live-search";

const cacheDir = mkdtempSync(join(tmpdir(), "reemco-last-seen-"));
process.env.COLLECT_CACHE_DIR = cacheDir;
process.env.KV_REST_API_URL = "";
process.env.KV_REST_API_TOKEN = "";

const { rememberRound, fillSilentFromLastSeen, resetLastSeenForTests, LAST_SEEN_MAX_AGE_MS, MAX_SNAPSHOT_OFFERS } =
  await import("@/lib/collect/last-seen");
const { collectedClock } = await import("@/lib/relative-time");
const { sortOffers } = await import("@/lib/format");
const { collectLiveResults } = await import("@/lib/collect/live-search");
const ProductResultCard = (await import("@/components/ProductResultCard")).default;

function hit(merchant: string, price: number, title = `${merchant} deal`, collectedAt?: string): SearchHit {
  return {
    title,
    merchant,
    price,
    currency: "KWD",
    url: `https://${merchant.toLowerCase().replace(/\s+/g, "")}.example/p`,
    inStock: true,
    country: "KW",
    ...(collectedAt ? { collectedAt } : {}),
  };
}

afterEach(() => cleanup());

describe("REEA-510 last-seen snapshot store", () => {
  it("fills only silent merchants, keeps hop stamps, marks rows", async () => {
    resetLastSeenForTests(cacheDir);
    const stamp = "2026-09-10T11:20:00.000Z";
    // An earlier round where BOTH retailers answered live writes snapshots.
    await rememberRound(
      "wh-1000xm6",
      [
        { merchant: "Quadra Stores", hits: [hit("Quadra Stores", 45, "Sony WH-1000XM6", stamp)] },
        { merchant: "Lulu Hypermarket", hits: [hit("Lulu Hypermarket", 47, "Sony WH-1000XM6", stamp)] },
      ],
      Date.parse(stamp),
      cacheDir,
    );
    // Next run: Quadra answers live again, Lulu stayed silent. Only the
    // silent column reads back its snapshot (AC: live hits keep fallbacks
    // out of the served set entirely).
    const fill = await fillSilentFromLastSeen(
      "WH-1000XM6", // normalized case-insensitively onto the write key
      null,
      [
        { merchant: "Quadra Stores", hits: [hit("Quadra Stores", 44, "Sony WH-1000XM6")] },
        { merchant: "Lulu Hypermarket", hits: [] },
      ],
      Date.parse(stamp) + 60_000,
      cacheDir,
    );
    expect(fill).toHaveLength(1);
    expect(fill[0].merchant).toBe("Lulu Hypermarket");
    expect(fill[0].fromSnapshot).toBe(true);
    // The ORIGINAL hop stamp survives — the label is the true collection time.
    expect(fill[0].collectedAt).toBe(stamp);
  });

  it("drops snapshots past the 24 h window but serves one inside it", async () => {
    resetLastSeenForTests(cacheDir);
    const t0 = Date.UTC(2026, 8, 10, 9, 0, 0);
    await rememberRound("aromatic rice", [{ merchant: "Sultan Center", hits: [hit("Sultan Center", 2)] },], t0, cacheDir);
    const key = ["Sultan Center"];
    const at = (offset: number) =>
      fillSilentFromLastSeen("aromatic rice", null, [{ merchant: "Sultan Center", hits: [] }], t0 + offset, cacheDir);
    expect(await at(LAST_SEEN_MAX_AGE_MS)).toHaveLength(1); // exactly 24 h: still servable
    expect(await at(LAST_SEEN_MAX_AGE_MS + 1)).toHaveLength(0); // past it: dropped
    expect(key).toHaveLength(1);
  });

  it("bounds the snapshot to the most recent offers per retailer+query", async () => {
    resetLastSeenForTests(cacheDir);
    const many = Array.from({ length: MAX_SNAPSHOT_OFFERS + 5 }, (_, i) => hit("PC Kuwait", 10 + i));
    await rememberRound("dell laptop", [{ merchant: "PC Kuwait", hits: many }], Date.now(), cacheDir);
    const fill = await fillSilentFromLastSeen(
      "Dell Laptop",
      null,
      [{ merchant: "PC Kuwait", hits: [] }],
      Date.now() + 1000,
      cacheDir,
    );
    expect(fill).toHaveLength(MAX_SNAPSHOT_OFFERS);
    // Best-first order preserved (the adapter's own answer order).
    expect(fill.map((h) => h.price)).toEqual(Array.from({ length: MAX_SNAPSHOT_OFFERS }, (_, i) => 10 + i));
  });

  it("snapshot rows sort below every live row in the card ladder", () => {
    const sorted = sortOffers([
      { merchant: "Quadra Stores", price: 20, currency: "KWD", url: "u", inStock: true, fromSnapshot: true },
      { merchant: "Xcite", price: 40, currency: "KWD", url: "u", inStock: false },
      { merchant: "Blink", price: 30, currency: "KWD", url: "u", inStock: true },
    ]);
    expect(sorted.map((o) => o.merchant)).toEqual(["Blink", "Xcite", "Quadra Stores"]);
  });

  it("renders the absolute collection clock on fallback rows", () => {
    expect(collectedClock("2026-09-10T14:05:00.000Z")).toBe("14:05");
    expect(collectedClock(undefined)).toBe(null);
    const { container } = render(
      <ProductResultCard
        query="أرز بسمتي"
        rank={0}
        locale="ar"
        renderStartMs={Date.UTC(2026, 8, 10, 10, 0, 0)}
        product={{
          productId: "rice",
          title: "أرز بسمتي",
          brand: "",
          offers: [
            // Live row: plain relative age against the baked render clock.
            { merchant: "Xcite", price: 2, currency: "KWD", url: "https://xcite.example/p", inStock: true, collectedAt: "2026-09-10T09:50:00.000Z" },
            // Snapshot row: absolute collection clock replaces the age.
            { merchant: "Sultan Center", price: 2.4, currency: "KWD", url: "https://sultan.example/p", inStock: true, collectedAt: "2026-09-10T14:05:00.000Z", fromSnapshot: true },
          ],
          coupons: [],
          variations: [],
          alternatives: [],
          scrapedAt: "2026-09-10T10:00:00.000Z",
        }}
      />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("جُمعت 14:05");
    expect(text).toContain("10m ago"); // the live row keeps its relative age
  });
});

describe("REEA-510 five-run coverage over the fixed query set", () => {
  const TIER = 200; // retry backoff ceiling per failed attempt
  void TIER;

  function rowsFor(
    products: { offers: { merchant: string; collectedAt?: string; fromSnapshot?: boolean }[] }[],
    merchant: string,
  ) {
    const rows: { collectedAt?: string; fromSnapshot?: boolean }[] = [];
    for (const p of products) for (const o of p.offers) if (o.merchant === merchant) rows.push(o);
    return rows;
  }

  it("iPhone 17 Pro: silent rounds fill from the snapshot, a fresh answer replaces it", async () => {
    let run = 0;
    const xciteBody = {
      results: [{ hits: [{ name: "Apple iPhone 17 Pro", slug: "ip17p", price: 305, currency: "KWD", inStock: true }] }],
    };
    const sultanBody = {
      status: "1",
      products: { product_list: [{ name: "Apple iPhone 17 Pro", slug: "ip17p-s", price: "325.0000", is_in_stock: "1" }] },
    };
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("xcite.com")) {
        // Live on rounds 1 and 3, silent otherwise — the flapping pattern the
        // four named retailers actually show.
        if (run === 1 || run === 3) {
          return new Response(JSON.stringify(xciteBody), { headers: { "content-type": "application/json" } });
        }
        throw new Error("xcite hop timed out");
      }
      if (url.includes("sultan-center.com")) {
        return new Response(JSON.stringify(sultanBody), { headers: { "content-type": "application/json" } });
      }
      if (url.includes("cnstrc.com") || url === "https://www.jarir.com/") {
        if (url.endsWith("jarir.com/")) {
          return new Response('x searchProviderKeys "key_r510test" y', { headers: { "content-type": "text/html" } });
        }
        return new Response(JSON.stringify({ response: { results: [{ data: { url: "p/ip", price: 111, metadata: { name: "Apple iPhone 17 Pro" } } }] } }), { headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("eureka.com.kw/")) {
        return new Response('<input id="cky" value="R510A1B2C3"><input id="srcapk" value="keyR510ab">', { headers: { "content-type": "text/html" } });
      }
      if (url.includes("algolia.net")) {
        return new Response(JSON.stringify({ hits: [{ itmn: "Apple iPhone 17 Pro", objectID: "5101", clprc: 315, avaqt: 3 }] }), { headers: { "content-type": "application/json" } });
      }
      return new Response('data-component-type="s-search-result" <h2 aria-label="Apple iPhone 17 Pro"></h2><span class="a-offscreen">EGP 9,900</span><a href="/dp/B510">z</a>');
    };

    let stampA = "";
    let stampC = "";
    let visible = 0;
    let live = 0;
    for (run = 1; run <= 5; run++) {
      // snapshots:true — this chain injects its own fetchImpl, so it opts in
      // explicitly to the shared last-seen store (documented contract).
      const snap = await collectLiveResults("iPhone 17 Pro", { fetchImpl, snapshots: true });
      const rows = rowsFor(snap.products, "Xcite");
      const note = snap.notes.find((n) => n.merchant === "Xcite");
      expect(rows.length).toBeGreaterThan(0); // AC: no blank column once a live answer exists
      visible++;
      if (!note?.error) live++;
      if (run === 1) {
        expect(rows[0].fromSnapshot).toBeFalsy();
        stampA = rows[0].collectedAt ?? "";
        expect(stampA).not.toBe("");
      }
      if (run === 2) {
        // Silent live round: snapshot rows, original hop stamp, labeled marker.
        expect(rows[0].fromSnapshot).toBe(true);
        expect(rows[0].collectedAt).toBe(stampA);
        expect(note?.error).toBeTruthy(); // diagnostics stay honest
        // Live-above-fallback ladder: the Xcite snapshot row (KD 305) rides
        // BELOW every live row even though the live Sultan listing is more
        // expensive (KD 325) — the flag leads the ladder, price orders inside
        // each tier (the other stubbed live listings rank cheapest-first).
        const card = snap.products.find((p) => p.offers.some((o) => o.merchant === "Xcite"));
        expect(card?.offers.map((o) => o.merchant.slice(0, 3))).toEqual(["Jar", "Eur", "Sul", "Xci"]);
      }
      if (run === 3) {
        // A fresh live answer replaces the fallback automatically…
        expect(rows[0].fromSnapshot).toBeFalsy();
        stampC = rows[0].collectedAt ?? "";
        expect(stampC).not.toBe(stampA);
      }
      if (run === 4) {
        // …and later silent rounds fill from the NEWER snapshot.
        expect(rows[0].fromSnapshot).toBe(true);
        expect(rows[0].collectedAt).toBe(stampC);
      }
    }
    // Empty-column rate across the five rounds: every round shows the
    // retailer once it has answered live at least once (was 3 blanks of 5).
    expect(visible).toBe(5);
    expect(live).toBeLessThanOrEqual(2);
  }, 30_000);

  it("أرز بسمتي: the AR query rides the same fill path", async () => {
    let run = 0;
    // REEA-635 C3 — the dispatch-level LatinBridge lands `أرز بسمتي` on the
    // catalogs' Latin spelling ("rice basmati"), and per the REEA-408
    // measurement these zones answer that shape with English-titled rows
    // ("Country Xl Organic Basmati Rice" &co). The fixtures carry the titles
    // the storefronts actually return; the shopper-side match back onto the
    // Arabic query rides the curated aliases in relevance.ts.
    const xciteBody = {
      results: [{ hits: [{ name: "Egyptian Basmati Rice 1 kg", slug: "rice-ar", price: 2.4, currency: "KWD", inStock: true }] }],
    };
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("xcite.com")) {
        return new Response(JSON.stringify(xciteBody), { headers: { "content-type": "application/json" } });
      }
      if (url.includes("sultan-center.com")) {
        if (run === 1) {
          return new Response(
            JSON.stringify({ status: "1", products: { product_list: [{ name: "Basmati Rice 5 kg", slug: "rice-s", price: "2.1800", is_in_stock: "1" }] } }),
            { headers: { "content-type": "application/json" } },
          );
        }
        throw new Error("sultan hop timed out");
      }
      return new Response("{}");
    };

    let stampA = "";
    for (run = 1; run <= 3; run++) {
      const snap = await collectLiveResults("أرز بسمتي", { fetchImpl, snapshots: true });
      const rows = rowsFor(snap.products, "Sultan Center");
      expect(rows.length).toBeGreaterThan(0);
      if (run === 1) {
        expect(rows[0].fromSnapshot).toBeFalsy();
        stampA = rows[0].collectedAt ?? "";
      } else {
        expect(rows[0].fromSnapshot).toBe(true);
        expect(rows[0].collectedAt).toBe(stampA);
      }
      // Xcite answered live every round — the Arabic query path never needs a
      // fallback for merchants that actually respond.
      const xcite = rowsFor(snap.products, "Xcite");
      expect(xcite[0]?.fromSnapshot).toBeFalsy();
    }
  }, 30_000);
});
