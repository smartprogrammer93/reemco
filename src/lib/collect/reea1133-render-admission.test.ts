/**
 * REEA-1133 — page-render fan-out admission (F1 remediation of REEA-1121).
 *
 * REEA-1121 measured the deployed box answering 20 parallel distinct /results
 * renders with 20×HTTP 200 and zero 429s: every one of them ran the live
 * retailer fan-out, because acquireCollectionSlot() was only imported by the
 * collection runner. These pins prove the page path now goes through the SAME
 * process-wide cap with a bounded FAIL-CLOSED wait:
 *
 *  - a render that cannot be admitted inside RENDER_ADMISSION_WAIT_MS does NOT
 *    fan out; it serves an honest pending shell (no products, one note per
 *    lane) instead of multiplying the retailer lanes;
 *  - the same run is queued behind the response (bounded by
 *    RENDER_DEFERRED_WAIT_MS) and its follow-up placeholder is registered, so
 *    the open page still converges and the next repeat is warm;
 *  - an admitted run holds the slot for its whole tail and releases it;
 *  - a fresh memo hit takes no slot at all (the repeat path stays instant).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveSearchResult } from "@/lib/collect/coverage";
import type { FetchImpl } from "@/lib/collect/scraper";
import type { QueryCache } from "@/lib/query-cache";

// The admission windows are module-level constants read from env at import
// time: keep the fail-closed wait short enough that a saturated cap proves the
// drop quickly, and the deferred window long enough to exercise the queue.
process.env.REEMCO_MAX_INFLIGHT_COLLECTIONS = "2";
process.env.REEMCO_RENDER_ADMISSION_WAIT_MS = "60";
process.env.REEMCO_RENDER_DEFERRED_WAIT_MS = "1200";

const {
  MAX_INFLIGHT_COLLECTIONS,
  RENDER_ADMISSION_WAIT_MS,
  RENDER_DEFERRED_WAIT_MS,
  inflightCollectionCount,
  resetCollectionInflightForTests,
  tryAcquireCollectionSlot,
} = await import("@/lib/collect/inflight");
const { collectLiveResultsStagedAdmitted, followUpSnapshot } = await import(
  "@/lib/collect/live-search"
);
const { INFLIGHT_STALE_MS } = await import("@/lib/collect/types");

const okHtml = '<script type="application/ld+json">{"price":"11.5"}</script>';

function stubFetch(): FetchImpl {
  return async () => new Response(okHtml, { status: 200 });
}

/** Fill every slot, returning the release handles. */
async function saturate(): Promise<Array<() => void>> {
  const holders: Array<() => void> = [];
  for (let i = 0; i < MAX_INFLIGHT_COLLECTIONS; i += 1) {
    const release = await tryAcquireCollectionSlot(0);
    expect(release).not.toBeNull();
    holders.push(release as () => void);
  }
  return holders;
}

function cachedAnswer(): LiveSearchResult {
  return {
    products: [],
    notes: [{ merchant: "Xcite", hits: 0 }],
    settled: true,
  };
}

function freshCache(value: LiveSearchResult): QueryCache {
  return {
    read: <T,>() => ({ value: value as unknown as T, stale: false }),
    write: () => {},
    size: () => 1,
    reset: () => {},
  };
}

beforeEach(() => {
  resetCollectionInflightForTests();
});

describe("REEA-1133 page-render admission", () => {
  it("pins a bounded, fail-closed render wait inside the stale-run window", () => {
    expect(MAX_INFLIGHT_COLLECTIONS).toBe(2);
    expect(RENDER_ADMISSION_WAIT_MS).toBeGreaterThan(0);
    // The deferred wait is the queue bound; both must stay under the
    // stale-collecting reap window so a queued render never looks dead.
    expect(RENDER_DEFERRED_WAIT_MS).toBeGreaterThanOrEqual(RENDER_ADMISSION_WAIT_MS);
    expect(RENDER_DEFERRED_WAIT_MS).toBeLessThan(INFLIGHT_STALE_MS);
  });

  it("does NOT fan out when the cap is saturated: serves the pending shell, takes no slot", async () => {
    const holders = await saturate();
    const fetchImpl = vi.fn(stubFetch());

    const stages = await collectLiveResultsStagedAdmitted("reea1133 busy query", {
      fetchImpl,
      snapshots: false,
    });
    const served = await stages.final;

    // No retailer hop ran — the render never multiplied the fan-out.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(served.products).toEqual([]);
    expect(served.settled).toBe(false);
    // One honest note per lane the fan-out would have contacted: a capacity
    // deferral must never read as a zero-result answer.
    expect(served.notes.length).toBeGreaterThan(0);
    expect(served.notes.every((n) => (n.error ?? "").includes("deferred"))).toBe(true);
    expect(served.responders?.noResponse.length).toBeGreaterThan(0);
    expect(stages.serveKind).toBe("cold");
    // The denied render did not borrow capacity from the saturated cap.
    expect(inflightCollectionCount()).toBe(MAX_INFLIGHT_COLLECTIONS);

    // Drain the queued run exactly like the page's after() tail does: freeing
    // a slot admits it, so its slot must come back before the next case (a
    // leaked late release would corrupt the shared counter across tests).
    for (const release of holders) release();
    await stages.allSettled;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inflightCollectionCount()).toBe(0);
  });

  it("queues the denied run behind the response and converges through the follow-up placeholder", async () => {
    const holders = await saturate();
    const fetchImpl = vi.fn(stubFetch());

    const stages = await collectLiveResultsStagedAdmitted("reea1133 queued query", {
      fetchImpl,
      snapshots: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    // The follow-up feed must find this query's queued run (a same-worker
    // lookup that found nothing would start a second unadmitted fan-out).
    expect(followUpSnapshot("reea1133 queued query")).not.toBeNull();

    // Free one slot: the deferred run is admitted behind the response and
    // performs the real fan-out.
    holders.shift()?.();
    const converged = await stages.converged;
    expect(fetchImpl).toHaveBeenCalled();
    expect(Array.isArray(converged.products)).toBe(true);
    expect(converged.settled).not.toBe(false);

    await stages.allSettled;
    // Let the release microtask run, then the deferred slot is back.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inflightCollectionCount()).toBe(MAX_INFLIGHT_COLLECTIONS - 1);
    for (const release of holders) release();
  });

  it("drops the queued run fail-closed when no slot frees inside the deferred window", async () => {
    const holders = await saturate();
    const fetchImpl = vi.fn(stubFetch());

    const stages = await collectLiveResultsStagedAdmitted("reea1133 dropped query", {
      fetchImpl,
      snapshots: false,
    });
    // No release: the deferred window expires without capacity.
    const converged = await stages.converged;
    await stages.allSettled;
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(converged.products).toEqual([]);
    expect(converged.settled).toBe(false);
    expect(inflightCollectionCount()).toBe(MAX_INFLIGHT_COLLECTIONS);

    for (const release of holders) release();
  });

  it("runs the fan-out when a slot is free and releases it after the tail", async () => {
    const fetchImpl = vi.fn(stubFetch());
    const stages = await collectLiveResultsStagedAdmitted("reea1133 admitted query", {
      fetchImpl,
      snapshots: false,
    });
    expect(fetchImpl).toHaveBeenCalled();
    expect(inflightCollectionCount()).toBe(1);

    await stages.allSettled;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(inflightCollectionCount()).toBe(0);
  });

  it("takes no slot for a fresh memo hit (repeat path stays instant)", async () => {
    const holders = await saturate();
    const fetchImpl = vi.fn(stubFetch());
    const answer = cachedAnswer();

    const stages = await collectLiveResultsStagedAdmitted("reea1133 warm query", {
      fetchImpl,
      snapshots: false,
      cache: freshCache(answer),
    });
    const served = await stages.final;

    // A saturated cap must not make a memo hit wait or fan out.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(served.products).toEqual([]);
    expect(stages.serveKind).toBe("warm");
    expect(inflightCollectionCount()).toBe(MAX_INFLIGHT_COLLECTIONS);

    for (const release of holders) release();
  });
});
