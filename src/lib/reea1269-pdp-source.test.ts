/**
 * REEA-1269 (Bet 1b) — the source-query hint for live-only product keys.
 *
 * Measured on the deployed head: three of a 25-URL sample of the collected
 * inventory served `<div class="rc-offers-table" aria-busy="true">` with zero
 * offer rows on a bare slug, while the same URL with `?q=samsung` painted the
 * shelf's offers. A sitemap URL cannot carry `?q=` (its canonical is the bare
 * path), so the query that minted the key is persisted server-side and the
 * PDP dispatches it for a bare visit — the advertised URL then renders the
 * offer set the sitemap promised (S-2) instead of an empty table.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSharedKv: vi.fn(),
  readLiveQueryMemo: vi.fn(),
  collectLiveResultsStagedAdmitted: vi.fn(),
  readRetiredLanes: vi.fn(),
}));

vi.mock("@/lib/collect/kv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/collect/kv")>();
  return { ...actual, getSharedKv: mocks.getSharedKv };
});

vi.mock("@/lib/collect/live-search", () => ({
  collectLiveResults: vi.fn(),
  collectLiveResultsStagedAdmitted: mocks.collectLiveResultsStagedAdmitted,
  readLiveQueryMemo: mocks.readLiveQueryMemo,
  RESULTS_COMPLETION_BUDGET_MS: 1_800,
  STAGE_TAIL_HEADROOM_MS: 6_200,
}));

vi.mock("@/lib/collect/lane-health", () => ({
  readRetiredLanes: mocks.readRetiredLanes,
}));

const { readPdpSource, recordPdpSources, PDP_SOURCE_TTL_S, pdpSourceKey } = await import(
  "@/lib/pdp-source"
);
const { resolveProductIdentity } = await import("@/lib/product-identity");

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return true;
    }),
    mget: vi.fn(async (keys: string[]) => keys.map((key) => store.get(key) ?? null)),
    keys: vi.fn(async () => [...store.keys()]),
  };
}

beforeEach(() => {
  mocks.getSharedKv.mockReset();
  mocks.getSharedKv.mockReturnValue(null);
  mocks.readLiveQueryMemo.mockReset();
  mocks.readLiveQueryMemo.mockReturnValue(null);
  mocks.collectLiveResultsStagedAdmitted.mockReset();
  mocks.readRetiredLanes.mockReset();
  mocks.readRetiredLanes.mockResolvedValue([]);
});

describe("REEA-1269 — source-query hint store", () => {
  it("writes the minting query only when the key has none", async () => {
    const kv = fakeKv({ [pdpSourceKey("samsung-crystal-uhdu8000h-4k")]: "samsung" });
    mocks.getSharedKv.mockReturnValue(kv);
    const written = await recordPdpSources([
      { productId: "samsung-crystal-uhdu8000h-4k", query: "samsung" },
      { productId: "nestle-s26", query: "samsung" },
    ]);
    expect(written).toBe(1);
    expect(kv.store.get(pdpSourceKey("nestle-s26"))).toBe("samsung");
    expect(kv.set).toHaveBeenCalledWith(pdpSourceKey("nestle-s26"), "samsung", PDP_SOURCE_TTL_S);
    expect(kv.set).toHaveBeenCalledTimes(1);
  });

  it("does not mistake a failed batch read for an empty store", async () => {
    const kv = fakeKv();
    kv.mget.mockResolvedValue(null as unknown as (string | null)[]);
    mocks.getSharedKv.mockReturnValue(kv);
    const written = await recordPdpSources([{ productId: "sony-wh-1000xm6", query: "sony" }]);
    expect(written).toBe(0);
    expect(kv.set).not.toHaveBeenCalled();
  });

  it("degrades to null with no binding", async () => {
    mocks.getSharedKv.mockReturnValue(null);
    await expect(readPdpSource("sony-wh-1000xm6")).resolves.toBeNull();
    await expect(recordPdpSources([{ productId: "a", query: "b" }])).resolves.toBe(0);
  });

  it("reads back the stored source query", async () => {
    mocks.getSharedKv.mockReturnValue(fakeKv({ [pdpSourceKey("sony-wh-1000xm6")]: "sony" }));
    await expect(readPdpSource("sony-wh-1000xm6")).resolves.toBe("sony");
  });

  it("dispatches the hint for a bare slug so the PDP reproduces the shelf run", async () => {
    mocks.getSharedKv.mockReturnValue(
      fakeKv({ [pdpSourceKey("samsung-crystal-uhdu8000h-4k")]: "samsung" }),
    );
    const answer = {
      productId: "samsung-crystal-uhdu8000h-4k",
      title: "Samsung Crystal UHD U8000H 4K",
      brand: "Samsung",
      offers: [
        {
          merchant: "Xcite",
          price: 1299,
          currency: "KWD",
          url: "https://www.xcite.com/samsung-crystal-uhdu8000h/p",
          inStock: true,
          collectedAt: new Date().toISOString(),
        },
      ],
      coupons: [],
      variations: [],
      alternatives: [],
      scrapedAt: new Date().toISOString(),
    };
    mocks.collectLiveResultsStagedAdmitted.mockImplementation(async (query: string) => ({
      stages: [Promise.resolve({ products: [answer], notes: [], suggestions: [] })],
      final: Promise.resolve({ products: [answer], notes: [], suggestions: [] }),
      converged: Promise.resolve({ products: [answer], notes: [], suggestions: [] }),
      allSettled: Promise.resolve(null),
      adapterTelemetry: Promise.resolve({ attempts: {}, failures: {} }),
      serveKind: "cold" as const,
      dispatchedQuery: query,
    }));

    const resolved = await resolveProductIdentity("samsung-crystal-uhdu8000h-4k");
    expect(resolved?.productId).toBe("samsung-crystal-uhdu8000h-4k");
    const dispatched = mocks.collectLiveResultsStagedAdmitted.mock.calls.map((c) => c[0]);
    // The hint wins over the decoded slug phrase.
    expect(dispatched[0]).toBe("samsung");
  });
});
