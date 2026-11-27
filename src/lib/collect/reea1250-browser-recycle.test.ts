/**
 * REEA-1250 — the browser tier is a BOUNDED resource, not a process-lifetime
 * one.
 *
 * Security follow-up REEA-1245 measured the tier holding one long-lived
 * Chromium + context with no recycle: a 9.6 h instance sat at 5.077-5.411 GiB
 * of a 6 GiB cgroup, and a 40-query burst on a fresh instance settled ~0.88 GiB
 * above its baseline and never returned. The failure mode is an OOM kill and a
 * container restart, so the tier must close + relaunch after a bounded number
 * of navigations, on a memory threshold, and when it goes idle.
 *
 * These cases pin the decision and the lifecycle:
 *  - the default threshold is a pinned number (a regression that raises it
 *    silently fails here);
 *  - memory triggers are hysteretic (min navigations + min gap), so a process
 *    whose baseline is already high cannot relaunch on every navigation;
 *  - the cgroup trigger reads ANONYMOUS memory, not `memory.current` (page
 *    cache from the durable volumes is reclaimable and would page a healthy
 *    box);
 *  - after N navigations the shared browser is actually closed and the next
 *    navigation relaunches;
 *  - a recycle requested while another page is in flight is deferred until the
 *    last page closes — closing a context under a live navigation is the bug
 *    this guard exists to prevent.
 *
 * Chromium itself is mocked: the unit suite must not pay a real launch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.BROWSER_CLEARANCE = "on";
process.env.REDIS_URL = "";
process.env.KV_REST_API_URL = "";
process.env.KV_REST_API_TOKEN = "";

const h = vi.hoisted(() => ({
  state: {
    launches: 0,
    closes: 0,
    pages: 0,
    holdFirstPage: false,
    firstGate: null as Promise<void> | null,
    firstRelease: null as (() => void) | null,
  },
}));

const CLEARED_HTML = '<html><body><a class="product-item-link">Razer Laptop Sleeve 16</a></body></html>';

function makePage(): {
  goto: () => Promise<void>;
  waitForFunction: () => Promise<void>;
  content: () => Promise<string>;
  close: () => Promise<void>;
} {
  const index = h.state.pages;
  return {
    goto: async () => undefined,
    waitForFunction: async () => undefined,
    content: async () => {
      // The first page can be held open so a test can start a second
      // navigation while it is still in flight.
      if (index === 1 && h.state.holdFirstPage && h.state.firstGate) await h.state.firstGate;
      return CLEARED_HTML;
    },
    close: async () => undefined,
  };
}

function makeBrowser(): Record<string, unknown> {
  const context = {
    newPage: async () => {
      h.state.pages += 1;
      return makePage();
    },
    addCookies: async () => undefined,
    cookies: async () => [],
    addInitScript: async () => undefined,
    close: async () => undefined,
  };
  return {
    newContext: async () => context,
    version: () => "test-chromium",
    isConnected: () => true,
    on: () => undefined,
    close: async () => {
      h.state.closes += 1;
    },
  };
}

vi.mock("playwright-core", () => ({
  chromium: {
    launch: async () => {
      h.state.launches += 1;
      return makeBrowser();
    },
  },
}));

vi.mock("@sparticuz/chromium", () => ({
  default: { executablePath: async () => "/tmp/chromium", args: [] },
  inflate: async () => undefined,
  setupLambdaEnvironment: () => undefined,
}));

import {
  BROWSER_RECYCLE_DEFAULT_POLICY,
  browserClearedHtml,
  browserRecyclePolicy,
  browserTierStats,
  recycleReason,
  resetBrowserTierForTests,
} from "@/lib/collect/browser-clearance";

const savedEnv = { ...process.env };

function reset(): void {
  resetBrowserTierForTests();
  h.state.launches = 0;
  h.state.closes = 0;
  h.state.pages = 0;
  h.state.holdFirstPage = false;
  h.state.firstGate = null;
  h.state.firstRelease = null;
}

beforeEach(() => {
  reset();
  process.env.BROWSER_CLEARANCE = "on";
  process.env.BROWSER_RECYCLE_NAVIGATIONS = "3";
  // Disable the memory triggers for the lifecycle tests: the process's own
  // baseline is not what those cases are pinning.
  process.env.BROWSER_RECYCLE_RSS_MB = "100000";
  process.env.BROWSER_RECYCLE_HEAP_PERCENT = "100";
  process.env.BROWSER_RECYCLE_CGROUP_PERCENT = "100";
  process.env.BROWSER_IDLE_RECYCLE_MS = "0";
});

afterEach(() => {
  reset();
  process.env = { ...savedEnv };
});

function queryUrl(n: number): string {
  return `https://www.nextstore.com.kw/catalogsearch/result/?q=laptop-${n}`;
}

describe("REEA-1250 recycle policy is pinned", () => {
  it("keeps the measured default threshold and idle window", () => {
    // A regression that raises the navigation bound (or removes the idle
    // close) re-opens the ratchet; pin the numbers the ticket chose.
    expect(BROWSER_RECYCLE_DEFAULT_POLICY.maxNavigations).toBe(30);
    expect(BROWSER_RECYCLE_DEFAULT_POLICY.idleRecycleMs).toBe(120_000);
    expect(BROWSER_RECYCLE_DEFAULT_POLICY.maxCgroupAnonFraction).toBe(0.7);
    expect(BROWSER_RECYCLE_DEFAULT_POLICY.memoryRecycleMinNavigations).toBe(8);
  });

  it("recycles exactly at the navigation threshold, not before", () => {
    const policy = BROWSER_RECYCLE_DEFAULT_POLICY;
    const base = {
      msSinceLastRecycle: null,
      rssBytes: 0,
      heapUsedBytes: 0,
      heapLimitBytes: 0,
      cgroupAnonBytes: null,
      cgroupLimitBytes: null,
    };
    expect(recycleReason({ ...base, navigationsSinceRecycle: 29 }, policy)).toBe("");
    expect(recycleReason({ ...base, navigationsSinceRecycle: 30 }, policy)).toBe("navigations");
  });

  it("recycles on the cgroup ANONYMOUS ceiling, not on reclaimable page cache", () => {
    const policy = BROWSER_RECYCLE_DEFAULT_POLICY;
    const limit = 6_442_450_944;
    const base = {
      navigationsSinceRecycle: 10,
      msSinceLastRecycle: null,
      rssBytes: 0,
      heapUsedBytes: 0,
      heapLimitBytes: 0,
    };
    // 70% of the real 6 GiB cgroup is 4,509,715,660.8 B.
    expect(recycleReason({ ...base, cgroupAnonBytes: 4_400_000_000, cgroupLimitBytes: limit }, policy)).toBe("");
    expect(recycleReason({ ...base, cgroupAnonBytes: 4_510_000_000, cgroupLimitBytes: limit }, policy)).toBe("cgroup");
  });

  it("recycles on the Node RSS and heap thresholds", () => {
    const policy = BROWSER_RECYCLE_DEFAULT_POLICY;
    const base = {
      navigationsSinceRecycle: 10,
      msSinceLastRecycle: null,
      heapUsedBytes: 0,
      heapLimitBytes: 2048 * 1024 * 1024,
      cgroupAnonBytes: null,
      cgroupLimitBytes: null,
    };
    expect(recycleReason({ ...base, rssBytes: policy.maxRssBytes - 1 }, policy)).toBe("");
    expect(recycleReason({ ...base, rssBytes: policy.maxRssBytes }, policy)).toBe("rss");
    expect(recycleReason({ ...base, rssBytes: 0, heapUsedBytes: 1_600 * 1024 * 1024 }, policy)).toBe("heap");
  });

  it("does not let a high baseline thrash launches: memory triggers need work and a gap", () => {
    const policy = BROWSER_RECYCLE_DEFAULT_POLICY;
    const over = {
      rssBytes: policy.maxRssBytes + 1,
      heapUsedBytes: 0,
      heapLimitBytes: 0,
      cgroupAnonBytes: null,
      cgroupLimitBytes: null,
    };
    // Too few navigations since the last recycle.
    expect(recycleReason({ ...over, navigationsSinceRecycle: 7, msSinceLastRecycle: null }, policy)).toBe("");
    // Enough navigations, but the last recycle was 1 s ago.
    expect(recycleReason({ ...over, navigationsSinceRecycle: 10, msSinceLastRecycle: 1_000 }, policy)).toBe("");
    // Both gates satisfied.
    expect(recycleReason({ ...over, navigationsSinceRecycle: 10, msSinceLastRecycle: 120_000 }, policy)).toBe("rss");
  });

  it("lets the environment lower (or disable) the threshold", () => {
    process.env.BROWSER_RECYCLE_NAVIGATIONS = "5";
    expect(browserRecyclePolicy().maxNavigations).toBe(5);
    process.env.BROWSER_RECYCLE_NAVIGATIONS = "0";
    expect(browserRecyclePolicy().maxNavigations).toBe(0);
  });
});

describe("REEA-1250 the shared browser is recycled, not kept for the process lifetime", () => {
  it("closes the browser after N navigations and relaunches on the next query", async () => {
    for (let i = 0; i < 3; i++) {
      const html = await browserClearedHtml(queryUrl(i), ".product-item-link");
      expect(html).toContain("product-item-link");
    }
    // The third navigation crossed the threshold; its settle closed the tier.
    expect(h.state.launches).toBe(1);
    expect(h.state.closes).toBe(1);
    const stats = browserTierStats();
    expect(stats.recycles).toBe(1);
    expect(stats.lastRecycleReason).toBe("navigations");
    expect(stats.navigationsSinceRecycle).toBe(0);
    expect(stats.launched).toBe(false);

    // A closed tier must relaunch, not reuse the closed instance.
    const html = await browserClearedHtml(queryUrl(3), ".product-item-link");
    expect(html).toContain("product-item-link");
    expect(h.state.launches).toBe(2);
    expect(browserTierStats().navigationsSinceRecycle).toBe(1);
  });

  it("defers the recycle while another page is still navigating", async () => {
    process.env.BROWSER_RECYCLE_NAVIGATIONS = "1";
    h.state.holdFirstPage = true;
    h.state.firstGate = new Promise<void>((resolve) => {
      h.state.firstRelease = resolve;
    });

    const first = browserClearedHtml(queryUrl(0), ".product-item-link");
    // Let the first navigation reach its held page before starting the second.
    await vi.waitFor(() => expect(h.state.pages).toBe(1));
    const second = browserClearedHtml(queryUrl(1), ".product-item-link");
    await vi.waitFor(() => expect(h.state.pages).toBe(2));

    // The second navigation crossed the threshold, but the first page is still
    // in flight: the browser must stay open.
    await second;
    expect(h.state.closes).toBe(0);
    expect(browserTierStats().inFlightNavigations).toBe(1);

    h.state.firstRelease?.();
    await first;
    // Once the last page closed, the deferred recycle runs.
    expect(h.state.closes).toBe(1);
    expect(browserTierStats().recycles).toBe(1);
  });
});
