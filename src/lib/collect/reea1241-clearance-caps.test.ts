/**
 * REEA-1241 — bound the clearance hops and the shared-store cache.
 *
 * Security re-check REEA-1234 found the REEA-1221 clearance tiers read relay
 * and browser bodies uncapped and cached whole raw pages in the shared Valkey
 * store: `jina-cleared:*` alone measured 641 keys / 371.8 MB of a 384 MB
 * `allkeys-lru` keyspace that also carries `ratelimit:*` and `metrics:*`, so
 * cache churn could evict the per-IP gate or a weekly counter.
 *
 * These cases pin the class, not one instance:
 *  - every relay hop returns `""` for a body past the 2 MB read cap, and the
 *    store never sees that body;
 *  - a 1 MB body that paints the selector still answers this query (live-data
 *    fidelity) but is not written to the store (over the 256 KB value cap);
 *  - a small painted body is cached, and the stored value is under the cap;
 *  - a browser-tier `page.content()` past the cap is trimmed;
 *  - a pre-cap oversized cache entry is dropped on replay so the store drains
 *    instead of waiting out the old 6 h TTL.
 *
 * The Upstash-shaped REST wire is emulated in-process; the relay hosts are
 * faked too, so nothing touches the public internet. The relay tier is forced
 * `on` because the hermetic test default is `off`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.REDIS_URL = "";
process.env.KV_REST_API_URL = "https://kv.example.test/";
process.env.KV_REST_API_TOKEN = "test-token";
process.env.CLEARANCE_RELAY = "on";
process.env.BROWSER_CLEARANCE = "off";

import {
  BROWSER_MAX_CONTENT_BYTES,
  CLEARANCE_CACHE_MAX_VALUE_BYTES,
  RELAY_MAX_RESPONSE_BODY_BYTES,
  capContent,
  jinaClearedHtml,
  readPageContent,
  relayClearedHtml,
  relayMarkdown,
  type PageLike,
} from "@/lib/collect/browser-clearance";

const KV_ORIGIN = "https://kv.example.test";
const MICROLINK_ORIGIN = "https://api.microlink.io";
const JINA_ORIGIN = "https://r.jina.ai";

type Write = { key: string; value: string; ttl: number };
const table = new Map<string, { value: string; ttl: number }>();
const writes: Write[] = [];
const deletes: string[] = [];
let relayHtml = "";
let relayText = "";
let relayCalls = 0;

function reset(): void {
  table.clear();
  writes.length = 0;
  deletes.length = 0;
  relayHtml = "";
  relayText = "";
  relayCalls = 0;
}

/** Recover the value from the REST SET body (`<value>\nEX\n<ttl>`); HTML
 *  contains raw newlines, so split on the trailing options marker. */
function setBodyValue(body: string): { value: string; ttl: number } {
  const marker = body.lastIndexOf("\nEX\n");
  if (marker < 0) return { value: body, ttl: 0 };
  return { value: body.slice(0, marker), ttl: Number(body.slice(marker + 4)) };
}

vi.stubGlobal(
  "fetch",
  vi.fn(async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.origin === KV_ORIGIN) {
      const [, command, rawKey] = url.pathname.split("/");
      const key = decodeURIComponent(rawKey ?? "");
      if (command === "get") {
        return new Response(JSON.stringify({ result: table.get(key)?.value ?? null, ok: true }));
      }
      if (command === "set") {
        const { value, ttl } = setBodyValue(String(init?.body ?? ""));
        table.set(key, { value, ttl });
        writes.push({ key, value, ttl });
        return new Response(JSON.stringify({ result: "OK", ok: true }));
      }
      if (command === "del") {
        const existed = table.delete(key);
        deletes.push(key);
        return new Response(JSON.stringify({ result: existed ? 1 : 0, ok: true }));
      }
      throw new Error(`unexpected KV command ${command}`);
    }
    if (url.origin === MICROLINK_ORIGIN) {
      relayCalls += 1;
      return new Response(JSON.stringify({ data: { html: relayHtml } }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.origin === JINA_ORIGIN) {
      relayCalls += 1;
      return new Response(relayText, { headers: { "content-type": "text/plain" } });
    }
    throw new Error(`unexpected fetch ${url}`);
  }),
);

beforeEach(reset);

// The whole point: nothing larger than the value cap ever enters the store.
afterEach(() => {
  for (const write of writes) {
    expect(Buffer.byteLength(write.value, "utf8")).toBeLessThanOrEqual(CLEARANCE_CACHE_MAX_VALUE_BYTES);
  }
});

describe("REEA-1241 relay hops read through the bounded body cap", () => {
  const URL = "https://www.nextstore.com.kw/catalogsearch/result/?q=laptop";
  const TEN_MB = "x".repeat(10 * 1024 * 1024);

  it("microlink relay returns \"\" for a 10 MB answer and writes nothing to the store", async () => {
    // It PAINTS the selector, so the pre-fix code buffered the whole 10 MB
    // through res.json() and handed it (and the cache) the full document.
    relayHtml = TEN_MB + '<a class="product-item-link">X</a>';
    const html = await relayClearedHtml(URL, ".product-item-link");
    expect(html).toBe("");
    expect(writes).toHaveLength(0);
  });

  it("reader relay returns \"\" for a 10 MB answer and writes nothing to the store", async () => {
    relayText = TEN_MB + "app-product-card";
    const html = await jinaClearedHtml("https://gcc.luluhypermarket.com/en-kw/list/?search_text=laptop", "app-product-card");
    expect(html).toBe("");
    expect(writes).toHaveLength(0);
  });

  it("markdown relay returns \"\" for a 10 MB answer and writes nothing to the store", async () => {
    relayText = TEN_MB + " KD 109.000";
    const md = await relayMarkdown(URL, "KD");
    expect(md).toBe("");
    expect(writes).toHaveLength(0);
  });

  it("accepts a body just under the read cap", async () => {
    // ~1.9 MB of HTML + the envelope stays under the 2 MB read cap; the
    // answer must still reach the lane (it is simply not cached).
    relayHtml = "y".repeat(RELAY_MAX_RESPONSE_BODY_BYTES - 16 * 1024) + '<a class="product-item-link">X</a>';
    const html = await relayClearedHtml(URL, ".product-item-link");
    expect(html).toContain("product-item-link");
    expect(html.length).toBeGreaterThan(1_000_000);
    expect(writes).toHaveLength(0);
  });
});

describe("REEA-1241 no clearance answer above the cache value cap enters the store", () => {
  const URL = "https://www.nextstore.com.kw/catalogsearch/result/?q=laptop";

  it("a 1 MB painted body answers this query but stores nothing", async () => {
    relayHtml = "a".repeat(1024 * 1024) + '<a class="product-item-link">Razer Laptop Sleeve 16</a>';
    const html = await relayClearedHtml(URL, ".product-item-link");
    // Live-data fidelity: the caller still gets the live body it needs.
    expect(html).toContain("product-item-link");
    expect(Buffer.byteLength(html, "utf8")).toBeGreaterThan(CLEARANCE_CACHE_MAX_VALUE_BYTES);
    // Nothing over the cap was stored (the afterEach check is the invariant;
    // this pins the exact decision for the 1 MB case).
    expect(writes).toHaveLength(0);
  });

  it("a small painted body is cached and the stored value is under the cap", async () => {
    relayHtml = '<html><body><a class="product-item-link">Razer Laptop Sleeve 16</a></body></html>';
    const html = await relayClearedHtml(URL, ".product-item-link");
    expect(html).toContain("product-item-link");
    expect(writes).toHaveLength(1);
    expect(writes[0].key).toBe(`relay-cleared:${URL}`);
    expect(writes[0].ttl).toBeLessThanOrEqual(30 * 60);
    expect(Buffer.byteLength(writes[0].value, "utf8")).toBeLessThanOrEqual(CLEARANCE_CACHE_MAX_VALUE_BYTES);

    // A repeat query replays the cache and spends no relay call.
    const callsBefore = relayCalls;
    const replayed = await relayClearedHtml(URL, ".product-item-link");
    expect(replayed).toContain("product-item-link");
    expect(relayCalls).toBe(callsBefore);
  });

  it("drops a pre-cap oversized cache entry on replay so the store drains", async () => {
    // An entry written before this fix holds the whole 1 MB page. It is still
    // valid live data, so this query gets it; it is then deleted instead of
    // holding its size in the allkeys-lru keyspace until the old TTL.
    const key = `relay-cleared:${URL}`;
    const old = "b".repeat(1024 * 1024) + '<a class="product-item-link">old</a>';
    table.set(key, { value: old, ttl: 6 * 60 * 60 });
    const html = await relayClearedHtml(URL, ".product-item-link");
    expect(html).toContain("product-item-link");
    expect(deletes).toContain(key);
    expect(table.has(key)).toBe(false);
    expect(relayCalls).toBe(0);
  });
});

describe("REEA-1241 browser-tier page.content is bounded", () => {
  it("trims a page.content() larger than the cap instead of passing it whole", async () => {
    const marker = '<a class="product-item-link">X</a>';
    const big = marker + "z".repeat(10 * 1024 * 1024);
    const page = { content: async () => big } as unknown as PageLike;
    const html = await readPageContent(page);
    expect(Buffer.byteLength(html, "utf8")).toBeLessThanOrEqual(BROWSER_MAX_CONTENT_BYTES);
    // The painted marker survives the trim, so the lane's presence gate and
    // parser still see real rows.
    expect(html).toContain("product-item-link");
    expect(html.length).toBeLessThan(big.length);
  });

  it("passes a page.content() under the cap through unchanged", async () => {
    const small = '<html><body><a class="product-item-link">X</a></body></html>';
    const page = { content: async () => small } as unknown as PageLike;
    expect(await readPageContent(page)).toBe(small);
  });

  it("capContent keeps documents at or under the byte cap", () => {
    expect(capContent("short", 32)).toBe("short");
    expect(Buffer.byteLength(capContent("x".repeat(64), 32), "utf8")).toBeLessThanOrEqual(32);
  });
});
