/**
 * REEA-1078 AC9 — the zone-reachability record the results page reads to name
 * a blocked lane as unreachable. The record is sourced from the same zone
 * probes /api/echo reports, so these pins cover the mapping, the freshness
 * rule and the fail-open posture (never a label on stale or unknown data).
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { SharedKv } from "@/lib/collect/kv";
import {
  LANE_ZONES,
  ZONE_STATUS_FRESH_MS,
  ZONE_STATUS_KEY,
  emptyZoneStatusState,
  mergeZoneStatus,
  normalizeZoneStatusState,
  probeLaneZones,
  readUnreachableLanes,
  recordEchoZoneStatus,
  resetZoneStatusMemo,
  resetZoneStatusRunState,
  unreachableMerchants,
  zoneEntriesFromEcho,
} from "@/lib/collect/zone-status";

function fakeKv(seed: Record<string, string> = {}, down = false): SharedKv & { dump: () => Record<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    async get(key: string) {
      if (down) return null;
      return map.has(key) ? map.get(key)! : null;
    },
    async set(key: string, value: string) {
      if (down) return false;
      map.set(key, value);
      return true;
    },
    dump: () => Object.fromEntries(map),
  };
}

const now = Date.parse("2026-11-23T00:00:00.000Z");

describe("unreachableMerchants (AC9 freshness rule)", () => {
  it("names a fresh blocked zone by its merchant spelling", () => {
    const state = {
      version: 1 as const,
      zones: {
        "www.luluhypermarket.com": {
          host: "www.luluhypermarket.com",
          merchant: "Lulu Hypermarket",
          reachable: false,
          checkedAt: new Date(now - 60_000).toISOString(),
        },
      },
    };
    expect(unreachableMerchants(state, now)).toEqual(["Lulu Hypermarket"]);
  });

  it("withholds a stale observation instead of claiming an old state", () => {
    const state = {
      version: 1 as const,
      zones: {
        "www.luluhypermarket.com": {
          host: "www.luluhypermarket.com",
          merchant: "Lulu Hypermarket",
          reachable: false,
          checkedAt: new Date(now - ZONE_STATUS_FRESH_MS - 1).toISOString(),
        },
      },
    };
    expect(unreachableMerchants(state, now)).toEqual([]);
  });

  it("never labels a zone that answered", () => {
    const state = {
      version: 1 as const,
      zones: {
        "www.luluhypermarket.com": {
          host: "www.luluhypermarket.com",
          merchant: "Lulu Hypermarket",
          reachable: true,
          checkedAt: new Date(now).toISOString(),
        },
      },
    };
    expect(unreachableMerchants(state, now)).toEqual([]);
  });
});

describe("zoneEntriesFromEcho — one source with /api/echo", () => {
  it("maps the echo cells onto the same reachability boolean", () => {
    const entries = zoneEntriesFromEcho(
      {
        "www.luluhypermarket.com": { status: 403, clearedBytes: 0 },
        "www.nextstore.com.kw": { status: 200 },
      },
      now,
    );
    expect(entries).toEqual([
      {
        host: "www.luluhypermarket.com",
        merchant: "Lulu Hypermarket",
        reachable: false,
        checkedAt: "2026-11-23T00:00:00.000Z",
      },
      {
        host: "www.nextstore.com.kw",
        merchant: "Next Store",
        reachable: true,
        checkedAt: "2026-11-23T00:00:00.000Z",
      },
    ]);
  });

  it("does not promote a block page with bytes to an answer", () => {
    // Measured on the live box 2026-11-23: Lulu's CF interstitial is ~4.5 KB
    // of cleared bytes but carries no application/ld+json block — the exact
    // shape the collector rejects. Only a 200 status is an echo-cell answer;
    // the daily probe applies the zone's real cleared-body rule.
    const [lulu] = zoneEntriesFromEcho(
      { "www.luluhypermarket.com": { status: 0, clearedBytes: 4555 } },
      now,
    );
    expect(lulu.reachable).toBe(false);
  });

  it("records the echo observation into the shared record", async () => {
    resetZoneStatusRunState();
    const kv = fakeKv();
    await recordEchoZoneStatus(
      { "www.luluhypermarket.com": { status: 403, clearedBytes: 0 } },
      { kv, now },
    );
    expect(await readUnreachableLanes({ kv, now })).toEqual(["Lulu Hypermarket"]);
  });
});

describe("probeLaneZones", () => {
  it("reads the zone's own answered rule from the live hop", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes("luluhypermarket")) {
        return new Response('<html><script type="application/ld+json">{}</script></html>');
      }
      return new Response("<html>ok</html>");
    }) as unknown as typeof fetch;
    const entries = await probeLaneZones(fetchImpl, now);
    expect(entries.map((e) => [e.merchant, e.reachable])).toEqual([
      ["Lulu Hypermarket", true],
      ["Next Store", true],
    ]);
    expect(entries.every((e) => e.host === LANE_ZONES.find((z) => z.merchant === e.merchant)?.host)).toBe(true);
  });

  it("reports a block-page answer as unreachable", async () => {
    const fetchImpl = (async () =>
      new Response("<html>Just a moment…</html>", { status: 403 })) as unknown as typeof fetch;
    const entries = await probeLaneZones(fetchImpl, now);
    expect(entries.every((e) => e.reachable === false)).toBe(true);
  });
});

describe("fail-open posture", () => {
  beforeEach(() => resetZoneStatusRunState());

  it("returns no labels when the store is unreachable", async () => {
    expect(await readUnreachableLanes({ kv: fakeKv({}, true), now })).toEqual([]);
  });

  it("returns no labels when nothing has been recorded yet", async () => {
    expect(await readUnreachableLanes({ kv: fakeKv(), now })).toEqual([]);
  });

  it("survives a malformed stored blob", async () => {
    resetZoneStatusMemo();
    const kv = fakeKv({ [ZONE_STATUS_KEY]: "{not json" });
    expect(await readUnreachableLanes({ kv, now })).toEqual([]);
  });

  it("normalizes a stored record defensively", () => {
    expect(normalizeZoneStatusState(null)).toEqual(emptyZoneStatusState());
    const state = normalizeZoneStatusState({
      zones: {
        "www.luluhypermarket.com": { merchant: "Lulu Hypermarket", reachable: "yes", checkedAt: "junk" },
        "www.nextstore.com.kw": { merchant: "Next Store", reachable: true, checkedAt: new Date(now).toISOString() },
      },
    });
    expect(Object.keys(state.zones)).toEqual(["www.nextstore.com.kw"]);
    expect(state.zones["www.nextstore.com.kw"].reachable).toBe(true);
  });

  it("merges observations without dropping other zones", () => {
    const base = {
      version: 1 as const,
      zones: {
        "www.nextstore.com.kw": {
          host: "www.nextstore.com.kw",
          merchant: "Next Store",
          reachable: false,
          checkedAt: new Date(now - 1000).toISOString(),
        },
      },
    };
    const merged = mergeZoneStatus(base, [
      {
        host: "www.luluhypermarket.com",
        merchant: "Lulu Hypermarket",
        reachable: false,
        checkedAt: new Date(now).toISOString(),
      },
    ]);
    expect(Object.keys(merged.zones).sort()).toEqual([
      "www.luluhypermarket.com",
      "www.nextstore.com.kw",
    ]);
    expect(base.zones["www.nextstore.com.kw"].reachable).toBe(false); // input untouched
  });
});
