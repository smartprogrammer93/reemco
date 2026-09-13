/**
 * REEA-882 — the product page must keep its collect run alive PAST the
 * streamed response.
 *
 * The REEA-248/693 render holds only `firstStage` (the promise that resolves
 * when the FIRST retailer answers). Everything after it in runCollection is a
 * floating promise: once the streamed document ends, the serverless
 * invocation freezes, the runner dies mid-run with subtasks stuck
 * "collecting", and the REEA-870 reap marks the job "failed" with 0 offers at
 * ~30s — every product page, every visit. The fix pins the class at the page:
 * the page keeps the full StagedProductCollection handle and registers the
 * run's `finalStage` behind `after()` (the results page's REEA-398 shape).
 *
 * These pins exercise the real page module (server component called directly,
 * request-time reads mocked) so the regression this guards — dropping the
 * after() registration, or pinning the tail to firstStage instead of
 * finalStage — cannot land silently.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectJob } from "@/lib/collect/types";
import type { NormalizedProduct } from "@/types/product";
import CollectionPanel from "@/components/CollectionPanel";

const mocks = vi.hoisted(() => ({
  startStaged: vi.fn(),
  resolveIdentity: vi.fn(),
  afterTasks: [] as Array<() => unknown>,
}));

vi.mock("@/lib/collect/runner", () => ({
  startProductCollectionStaged: mocks.startStaged,
}));

vi.mock("@/lib/product-identity", () => ({
  resolveProductIdentity: mocks.resolveIdentity,
}));

vi.mock("next/server", () => ({
  after: (task: () => unknown) => {
    mocks.afterTasks.push(task);
  },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: () => null }),
}));

import ProductPage from "./product/[productId]/page";

function product(): NormalizedProduct {
  return {
    productId: "reea882-probe",
    title: "Keepalive Probe Product",
    brand: "Test",
    offers: [
      {
        merchant: "Alpha",
        price: 10,
        currency: "KWD",
        url: "https://alpha.example/p/1",
        inStock: true,
      },
    ],
    coupons: [],
    variations: [],
    alternatives: [],
  };
}

function job(status: CollectJob["status"]): CollectJob {
  return {
    jobId: "job-reea882",
    productId: "reea882-probe",
    status,
    mode: "live",
    startedAt: new Date().toISOString(),
    subtasks: [],
    offers: [],
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type PanelElement = {
  props: { firstStage?: Promise<CollectJob | null> };
};

/** Walk the returned element tree down to the CollectionPanel element. */
function findPanel(node: unknown): PanelElement | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findPanel(child);
      if (found) return found;
    }
    return null;
  }
  const el = node as { type?: unknown; props?: { children?: unknown } };
  if (el.type === CollectionPanel) return el as unknown as PanelElement;
  return el.props ? findPanel(el.props.children) : null;
}

function renderPage() {
  return ProductPage({
    params: Promise.resolve({ productId: "reea882-probe" }),
    searchParams: Promise.resolve({}),
  } as unknown as Parameters<typeof ProductPage>[0]);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  mocks.afterTasks.length = 0;
  mocks.startStaged.mockReset();
  mocks.resolveIdentity.mockReset();
  mocks.resolveIdentity.mockResolvedValue(product());
  delete process.env.STATIC_EXPORT;
});

describe("product page run keep-alive (REEA-882)", () => {
  it("schedules the run tail via after() and the tail awaits finalStage, not firstStage", async () => {
    const first = deferred<CollectJob>();
    const final = deferred<CollectJob>();
    mocks.startStaged.mockResolvedValue({
      jobId: "job-reea882",
      firstStage: first.promise,
      finalStage: final.promise,
    });

    const el = await renderPage();

    // Exactly one deferred task, registered during render.
    expect(mocks.afterTasks).toHaveLength(1);

    // REEA-693 handshake unchanged: the panel still receives a firstStage
    // promise that lands with the FIRST retailer answer, before the run ends.
    const panel = findPanel(el);
    expect(panel).not.toBeNull();
    const firstStage = panel?.props.firstStage;
    expect(firstStage).toBeInstanceOf(Promise);
    first.resolve(job("collecting"));
    await expect(firstStage).resolves.toMatchObject({ jobId: "job-reea882" });

    // The registered tail must NOT settle while only firstStage has: the
    // whole point of the fix is that the invocation outlives the streamed
    // response until the FULL run finalizes.
    const tail = mocks.afterTasks[0] as () => Promise<unknown>;
    const tailPromise = tail.call(null);
    let tailSettled = false;
    void tailPromise.then(() => {
      tailSettled = true;
    });
    await tick();
    await tick();
    expect(tailSettled).toBe(false);

    final.resolve(job("complete"));
    await expect(tailPromise).resolves.toMatchObject({ status: "complete" });
    expect(tailSettled).toBe(true);
  });

  it("a start that never began degrades to the null firstStage handshake with no hanging tail", async () => {
    mocks.startStaged.mockRejectedValue(new Error("store unavailable"));

    const el = await renderPage();

    expect(mocks.afterTasks).toHaveLength(1);
    const panel = findPanel(el);
    // A handshake that never started is not an error state (REEA-693): the
    // panel falls back to its client-initiated path.
    await expect(panel?.props.firstStage).resolves.toBeNull();
    // And the registered tail resolves instead of freezing the invocation.
    await expect(
      (mocks.afterTasks[0] as () => Promise<unknown>).call(null),
    ).resolves.toBeUndefined();
  });

  it("the static preview host registers no after() and keeps the client-initiated path", async () => {
    process.env.STATIC_EXPORT = "1";

    const el = await renderPage();

    expect(mocks.afterTasks).toHaveLength(0);
    expect(findPanel(el)?.props.firstStage).toBeUndefined();
  });
});
