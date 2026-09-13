/**
 * REEA-84 W1 — collection store/runner tests (T1/T2/T5/T6).
 *
 * Uses a temp cache dir and an injectable fetch so no network is touched.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectJob } from "@/lib/collect/types";
import { CACHE_TTL_MS, isFreshCompleted } from "@/lib/collect/types";
import type { NormalizedProduct } from "@/types/product";

const cacheDir = mkdtempSync(join(tmpdir(), "reemco-collect-test-"));
process.env.COLLECT_CACHE_DIR = cacheDir;

// Dynamic imports so the store picks up the temp cache dir.
const { resetStoreForTests, findFreshCompleted, findLastCompleted, getJob, finishJob } =
  await import("@/lib/collect/store");
const { startCollection, runCollection, retryRetailer, sortLiveOffers } =
  await import("@/lib/collect/runner");

vi.mock("next/server", () => ({ after: (fn: () => void) => fn() }));

let idCounter = 0;
function product(overrides: Partial<NormalizedProduct> = {}): NormalizedProduct {
  return {
    productId: overrides.productId ?? `test-product-${++idCounter}`,
    title: "Test Product",
    brand: "Test",
    offers: [
      {
        merchant: "Alpha",
        price: 10,
        currency: "KWD",
        url: "https://alpha.example/p/1",
        inStock: true,
      },
      {
        merchant: "Beta",
        price: 12,
        currency: "KWD",
        url: "https://beta.example/p/1",
        inStock: true,
      },
    ],
    coupons: [],
    variations: [],
    alternatives: [],
    ...overrides,
  };
}

const okHtml = '<script type="application/ld+json">{"price":"11.5"}</script>';
const oosHtml = '<meta property="product:price:amount" content="9.99"><div>availability: outofstock';

function fetchOk(url: string): Promise<Response> {
  const body = url.includes("beta") ? oosHtml : okHtml;
  return Promise.resolve(new Response(body, { status: 200 }));
}

beforeEach(() => {
  resetStoreForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("startCollection", async () => {
  it("creates a live job with one subtask per retailer and offers empty", async () => {
    const { job } = await startCollection(product());
    expect(job.status).toBe("collecting");
    expect(job.mode).toBe("live");
    expect(job.subtasks.map((s) => s.retailer)).toEqual(["Alpha", "Beta"]);
    expect(job.subtasks.every((s) => s.status === "pending")).toBe(true);
    expect(job.offers).toEqual([]);
  });

  it("dedupes an in-flight job for the same product (AC8)", async () => {
    const p = product();
    const first = await startCollection(p);
    const second = await startCollection(p);
    expect(second.deduped).toBe(true);
    expect(second.job.jobId).toBe(first.job.jobId);
  });

  it("always collects live even when a fresh completed job exists (REEA-95)", async () => {
    const p = product();
    const { job } = await startCollection(p);
    job.status = "complete";
    job.offers = [
      {
        merchant: "Alpha",
        domain: "alpha.example",
        price: 10,
        currency: "KWD",
        url: "https://alpha.example/p/1",
        inStock: true,
        collectedAt: new Date().toISOString(),
        method: "live",
      },
    ];
    // Simulate runner completion (persists + releases in-flight slot).
    
    await finishJob(job, cacheDir);
    const again = await startCollection(p);
    expect(again.servedFromCache).toBe(false);
    expect(again.job.mode).toBe("live");
    expect(again.job.jobId).not.toBe(job.jobId);
  });

  it("starts a fresh live run when the last completion is stale (>10 min)", async () => {
    const p = product();
    const { job } = await startCollection(p);
    job.status = "complete";
    await finishJob(job, cacheDir, Date.now() - CACHE_TTL_MS - 1000);
    const again = await startCollection(p);
    expect(again.servedFromCache).toBe(false);
    expect(again.job.mode).toBe("live");
    expect(again.job.jobId).not.toBe(job.jobId);
  });

  it("accepts force as a no-op — always-live is the default", async () => {
    const p = product();
    const { job } = await startCollection(p);
    job.status = "complete";
    
    await finishJob(job, cacheDir);
    const forced = await startCollection(p, { force: true });
    expect(forced.servedFromCache).toBe(false);
  });
});

describe("runCollection", async () => {
  it("fans out per retailer and completes with provenance-tagged offers (T2/T5)", async () => {
    const { job } = await startCollection(product());
    const done = await runCollection(job, product(), { fetchImpl: fetchOk, now: 1_000_000 });
    expect(done.status).toBe("complete");
    expect(done.subtasks.every((s) => s.status === "done")).toBe(true);
    expect(done.offers).toHaveLength(2);
    expect(done.offers[0].method).toBe("live");
    expect(new Date(done.offers[0].collectedAt).getTime()).toBe(1_000_000);
    expect(done.offers.find((o) => o.merchant === "Beta")?.inStock).toBe(false);
    expect(done.finishedAt).toBeTruthy();
    // In-flight slot released: next start is not deduped.
    const next = await startCollection(product());
    expect(next.deduped).toBe(false);
  });

  it("keeps partial success when one retailer fails (AC6)", async () => {
    const failing = (url: string): Promise<Response> =>
      url.includes("beta")
        ? Promise.reject(new Error("HTTP 503"))
        : Promise.resolve(new Response(okHtml, { status: 200 }));
    const { job } = await startCollection(product());
    const done = await runCollection(job, product(), { fetchImpl: failing });
    expect(done.status).toBe("complete");
    expect(done.subtasks.find((s) => s.retailer === "Beta")?.status).toBe("failed");
    expect(done.subtasks.find((s) => s.retailer === "Alpha")?.status).toBe("done");
    expect(done.offers).toHaveLength(1);
  });

  it("marks all retailers failed -> job failed with stale-cache link (AC6)", async () => {
    const failing = (): Promise<Response> => Promise.reject(new Error("boom"));
    const { job } = await startCollection(product(), { force: true });
    const done = await runCollection(job, product(), { fetchImpl: failing });
    expect(done.status).toBe("failed");
    expect(done.error).toBeTruthy();
    expect(done.offers).toHaveLength(0);
    expect(await findLastCompleted(done.productId)).toBeUndefined();
  });

  it("enforces the overall budget by timing out pending subtasks (AC7)", async () => {
    const hanging = (): Promise<Response> => new Promise(() => {});
    const { job } = await startCollection(product(), { force: true });
    const done = await runCollection(job, product(), {
      fetchImpl: hanging,
      overallBudgetMs: 50,
      now: Date.now(),
    });
    expect(done.subtasks.every((s) => s.status === "timeout" || s.status === "collecting")).toBe(true);
    expect(done.status).toBe("failed");
  });
});

describe("retryRetailer (T6)", async () => {
  it("retries one failed retailer and restores job completeness", async () => {
    let betaFails = true;
    const flaky = (url: string): Promise<Response> => {
      if (url.includes("beta") && betaFails) return Promise.reject(new Error("HTTP 503"));
      return Promise.resolve(new Response(okHtml, { status: 200 }));
    };
    const { job } = await startCollection(product(), { force: true });
    const first = await runCollection(job, product(), { fetchImpl: flaky });
    expect(first.status).toBe("complete");
    expect(first.subtasks.find((s) => s.retailer === "Beta")?.status).toBe("failed");

    betaFails = false;
    const retried = await retryRetailer(first, product(), "Beta", { fetchImpl: flaky });
    expect(retried?.status).toBe("complete");
    expect(retried?.subtasks.find((s) => s.retailer === "Beta")?.status).toBe("done");
    expect(retried?.offers).toHaveLength(2);
    // Alpha's original offer is preserved, not duplicated.
    expect(retried?.offers.filter((o) => o.merchant === "Alpha")).toHaveLength(1);
  });

  it("refuses retry while the job is still collecting", async () => {
    const { job } = await startCollection(product());
    const result = await retryRetailer(job, product(), "Alpha", { fetchImpl: fetchOk });
    expect(result).toBeUndefined();
  });
});

describe("freshness helpers (AC5)", async () => {
  it("isFreshCompleted respects status and TTL", async () => {
    const base: CollectJob = {
      jobId: "j",
      productId: "p",
      status: "complete",
      mode: "live",
      startedAt: new Date(Date.now() - 5000).toISOString(),
      finishedAt: new Date(Date.now() - 5000).toISOString(),
      subtasks: [],
      offers: [],
    };
    expect(isFreshCompleted(base)).toBe(true);
    expect(isFreshCompleted({ ...base, status: "failed" })).toBe(false);
    const stale = {
      ...base,
      finishedAt: new Date(Date.now() - CACHE_TTL_MS - 1).toISOString(),
    };
    expect(isFreshCompleted(stale)).toBe(false);
  });
});

describe("misc", async () => {
  it("sortLiveOffers orders by ascending price", async () => {
    const offers = [
      { merchant: "A", domain: "a", price: 3, currency: "KWD", url: "u", inStock: true, collectedAt: "", method: "live" as const },
      { merchant: "B", domain: "b", price: 1, currency: "KWD", url: "u", inStock: true, collectedAt: "", method: "live" as const },
    ];
    expect(sortLiveOffers(offers).map((o) => o.merchant)).toEqual(["B", "A"]);
  });

  it("findFreshCompleted reads through the persisted cache", async () => {
    const p = product();
    const { job } = await startCollection(p, { force: true });
    job.status = "complete";
    
    await finishJob(job);
    const fresh = await findFreshCompleted(p.productId);
    expect(fresh?.jobId).toBe(job.jobId);
    expect(await getJob(job.jobId)).toBeTruthy();
  });
});

describe("stale in-flight reaping (REEA-870)", async () => {
  const { reapStaleCollectingJob } = await import("@/lib/collect/runner");
  const { INFLIGHT_STALE_MS, isStaleCollectingJob } = await import("@/lib/collect/types");

  function collectingJob(overrides: Partial<CollectJob> = {}): CollectJob {
    return {
      jobId: `orphan-${++idCounter}`,
      productId: product().productId,
      status: "collecting",
      mode: "live",
      startedAt: new Date().toISOString(),
      subtasks: [
        { retailer: "Alpha", domain: "alpha.example", status: "done", offersFound: 1 },
        { retailer: "Beta", domain: "beta.example", status: "collecting", offersFound: 0 },
      ],
      offers: [],
      ...overrides,
    };
  }

  it("isStaleCollectingJob flags only collecting jobs past the staleness window", () => {
    const job = collectingJob();
    expect(isStaleCollectingJob(job)).toBe(false);
    expect(
      isStaleCollectingJob(
        collectingJob({ startedAt: new Date(Date.now() - INFLIGHT_STALE_MS - 1).toISOString() }),
      ),
    ).toBe(true);
    // A terminal job is never stale, whatever its age.
    expect(
      isStaleCollectingJob(
        collectingJob({
          status: "complete",
          startedAt: new Date(Date.now() - INFLIGHT_STALE_MS - 1).toISOString(),
        }),
      ),
    ).toBe(false);
    // An unparseable startedAt cannot be judged — never reaped.
    expect(isStaleCollectingJob(collectingJob({ startedAt: "not-a-date" }))).toBe(false);
  });

  it("reapStaleCollectingJob finalizes unsettled subtasks, keeps settled ones, and never caches as completed", async () => {
    const p = product();
    const job = collectingJob({ productId: p.productId });
    job.offers = [
      {
        merchant: "Alpha",
        domain: "alpha.example",
        price: 10,
        currency: "KWD",
        url: "https://alpha.example/p/1",
        inStock: true,
        collectedAt: new Date().toISOString(),
        method: "live",
      },
    ];
    const reaped = await reapStaleCollectingJob(job);
    expect(reaped.status).toBe("failed");
    expect(reaped.error).toBeTruthy();
    expect(reaped.subtasks.find((s) => s.retailer === "Beta")?.status).toBe("timeout");
    expect(reaped.subtasks.find((s) => s.retailer === "Alpha")?.status).toBe("done");
    // Live-data fidelity: partial offers from an interrupted run still render,
    // but the reaped artifact must never pose as a fresh completed collection.
    expect(await findFreshCompleted(p.productId)).toBeUndefined();
    // The reaped snapshot is published for polling surfaces.
    expect((await getJob(job.jobId))?.status).toBe("failed");
  });

  it("startCollection reaps an orphaned in-flight job and starts a fresh run instead of deduping onto it", async () => {
    const p = product();
    const dead = collectingJob({ productId: p.productId });
    dead.startedAt = new Date(Date.now() - INFLIGHT_STALE_MS - 1).toISOString();
    // Plant the orphan as the product's in-flight job, as a dead runner would
    // have left it: snapshot published, in-flight pointer aimed at it.
    const store = await import("@/lib/collect/store");
    await store.touchJob(dead);
    store.setInflightForTests(p.productId, dead.jobId);

    const again = await startCollection(p);
    expect(again.deduped).toBe(false); // never dedupe onto a dead run
    expect(again.job.jobId).not.toBe(dead.jobId);
    expect((await getJob(dead.jobId))?.status).toBe("failed"); // orphan reaped
  });

  it("still dedupes a fresh in-flight job (the healthy path, unchanged)", async () => {
    const p = product();
    const first = await startCollection(p);
    const second = await startCollection(p);
    expect(second.deduped).toBe(true);
    expect(second.job.jobId).toBe(first.job.jobId);
  });

  it("poll endpoint reaps a stale collecting job and serves a terminal snapshot (REEA-870 client contract)", async () => {
    const p = product();
    const dead = collectingJob({ productId: p.productId });
    dead.startedAt = new Date(Date.now() - INFLIGHT_STALE_MS - 1).toISOString();
    const store = await import("@/lib/collect/store");
    await store.touchJob(dead);

    const { GET } = await import("@/app/api/collect-jobs/[jobId]/route");
    const res = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ jobId: dead.jobId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CollectJob;
    expect(body.status).toBe("failed"); // spinner exits with a visible error state
    expect(body.error).toBeTruthy();

    // A fresh (non-stale) job still polls as-is.
    const live = await startCollection(p);
    const res2 = await GET(new Request("http://localhost/x"), {
      params: Promise.resolve({ jobId: live.job.jobId }),
    });
    expect(((await res2.json()) as CollectJob).status).toBe("collecting");
  });
});
