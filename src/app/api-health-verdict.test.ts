/**
 * REEA-1266 — GET /api/health verdict stability under concurrent page load.
 *
 * The REEA-1262 AC-1 probe measured 4 transient 503s out of 62 samples while
 * a 1 s page probe hammered `/`, `/results` and `/product`; every shopper
 * route answered 200 over the same window. The cause was this endpoint's own
 * funnel walk: when the process-wide collection admission cap
 * (lib/collect/inflight.ts, REEA-1133) defers the results hop, the served
 * document is the honest PENDING shell — zero cards by design — and the walk
 * answered 503 (cards=0), which the scheduled probe, the deploy verify gate
 * and the external monitor all read as an outage.
 *
 * These pins exercise the route as a plain handler with a stubbed funnel and
 * pin the fixed contract:
 *  - a provisional (pending-marker) shell is "still working", NOT an outage:
 *    HTTP 200 `{ok:true}`, and the walk stops before the product hop (there is
 *    no card to click out to);
 *  - once a full walk PROVED the results hop, a later provisional shell
 *    replays that proof inside the replay window instead of re-walking into
 *    the cap;
 *  - a SETTLED document that renders zero cards is still a hard 503 — the
 *    replay is scoped to the capacity-deferral case, so a genuinely broken
 *    funnel cannot hide behind it;
 *  - a settled zero is 503 even immediately after a proven walk;
 *  - "still working" is bounded: a provisional streak longer than the replay
 *    window with no proven walk in it is a real 503, so a permanently stuck
 *    funnel cannot read green forever.
 *
 * The marker itself is pinned from the renderer side in
 * src/components/reea1266-health-marker.test.tsx; this file consumes the same
 * constant pair so the two can never drift.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// `after()` schedules the daily link smoke / lane-health / zone-status passes
// behind the response. They are not under test here, so capture nothing and
// run nothing: the verdict path must be exercised in isolation.
vi.mock("next/server", () => ({
  after: () => {},
}));

// Module-level reads: pin the origin (no public-hostname hop) and a short,
// explicit replay window so the replay pin does not depend on wall-clock luck.
process.env.REEMCO_HEALTH_ORIGIN = "http://health.test";
process.env.REEMCO_HEALTH_VERDICT_REPLAY_MS = "1000";

const { GET } = await import("@/app/api/health/route");
const { resetRateLimiter } = await import("@/lib/rate-limit");
const {
  COLLECTION_PENDING_ATTR,
  COLLECTION_PENDING_VALUE,
  hasCollectionPendingShell,
} = await import("@/lib/collect/shell-markers");

const HOME_HTML = '<header class="site-header">Reemco</header>';
const PRODUCT_HTML = "<main>product page</main>";
// A real card: result-card class + a freshness chip + the click-out href the
// probe's until-chain waits for.
const PASS_RESULTS_HTML =
  '<article class="result-card"><span class="freshness-chip">Updated just now</span>' +
  '<a href="/product/sony-wh-1000xm5">Sony WH-1000XM5</a></article>';
// The honest pending shell the admission gate serves when it cannot admit the
// render (renderBusySnapshot): zero cards, one deferred note per lane, and the
// REEA-1266 marker.
const PENDING_RESULTS_HTML =
  '<p class="meta-stamp coverage-line">No response from Xcite.</p>' +
  `<span hidden ${COLLECTION_PENDING_ATTR}="${COLLECTION_PENDING_VALUE}"></span>`;
// A settled document that answered with zero cards: a genuine broken/empty
// funnel, and therefore still a hard 503.
const SETTLED_ZERO_RESULTS_HTML =
  '<p class="meta-stamp coverage-line">22 stores checked · none carry this.</p>';

type Funnel = { home: string; results: string; product: string };

let funnel: Funnel = {
  home: HOME_HTML,
  results: PASS_RESULTS_HTML,
  product: PRODUCT_HTML,
};

const fetchCalls: string[] = [];

const stubFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
  const url = String(input);
  fetchCalls.push(url);
  if (url.endsWith("/")) return new Response(funnel.home, { status: 200 });
  if (url.includes("/results")) return new Response(funnel.results, { status: 200 });
  if (url.includes("/product/")) return new Response(funnel.product, { status: 200 });
  return new Response("not found", { status: 404 });
});

/** A plain Request is enough: the handler only reads headers (REEA-782 shape). */
function healthReq(ip: string): NextRequest {
  return new Request("http://health.test/api/health", {
    headers: { "x-forwarded-for": `${ip}, 10.0.0.1` },
  }) as unknown as NextRequest;
}

beforeEach(() => {
  resetRateLimiter();
  fetchCalls.length = 0;
  funnel = { home: HOME_HTML, results: PASS_RESULTS_HTML, product: PRODUCT_HTML };
  vi.restoreAllMocks();
  vi.stubGlobal("fetch", stubFetch);
});

/** Body shape stays the REEA-377 minimum: verdict + build stamp only. */
async function verdictOf(res: Response): Promise<{ ok: boolean; build: string }> {
  const body = (await res.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["build", "ok"]);
  return body as { ok: boolean; build: string };
}

describe("REEA-1266 GET /api/health verdict under fan-out load", () => {
  // Ordered on purpose: the replay window is module state (like the REEA-37
  // limiter's buckets), so the pins build the proof in sequence rather than
  // resetting a module graph mid-file.
  it("a provisional shell with no proven walk yet answers 200 'still working', not 503", async () => {
    funnel.results = PENDING_RESULTS_HTML;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await GET(healthReq("203.0.113.10"));
    expect(res.status).toBe(200);
    expect((await verdictOf(res)).ok).toBe(true);
    // Home + results only: a pending shell carries no click-out href, so the
    // product hop must not be attempted.
    expect(fetchCalls.filter((u) => u.includes("/product/"))).toHaveLength(0);
    expect(fetchCalls).toHaveLength(2);
    // The "still working" decision is logged with the shell's own numbers.
    expect(warn.mock.calls.some(([line]) => String(line).includes("provisional shell"))).toBe(true);
  });

  it("a settled zero-card document is still a hard 503", async () => {
    funnel.results = SETTLED_ZERO_RESULTS_HTML;
    const res = await GET(healthReq("203.0.113.11"));
    expect(res.status).toBe(503);
    expect((await verdictOf(res)).ok).toBe(false);
  });

  it("a proven walk answers 200 and runs the full home → results → product chain", async () => {
    const res = await GET(healthReq("203.0.113.12"));
    expect(res.status).toBe(200);
    expect((await verdictOf(res)).ok).toBe(true);
    expect(fetchCalls.some((u) => u.includes("/product/sony-wh-1000xm5"))).toBe(true);
  });

  it("a settled zero right after a proven walk is STILL 503 (replay is scoped to provisional shells)", async () => {
    funnel.results = SETTLED_ZERO_RESULTS_HTML;
    const res = await GET(healthReq("203.0.113.13"));
    expect(res.status).toBe(503);
    expect((await verdictOf(res)).ok).toBe(false);
  });

  it("a provisional shell after a proven walk replays that verdict (200) instead of 503", async () => {
    funnel.results = PENDING_RESULTS_HTML;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await GET(healthReq("203.0.113.14"));
    expect(res.status).toBe(200);
    expect((await verdictOf(res)).ok).toBe(true);
    expect(fetchCalls.filter((u) => u.includes("/product/"))).toHaveLength(0);
    expect(warn.mock.calls.some(([line]) => String(line).includes("verdict=replay"))).toBe(true);
  });

  it("a provisional streak longer than the window with no proven walk is a real 503", async () => {
    // "Still working" is bounded: past the replay window with no proof at all,
    // the probe stops claiming the funnel is fine.
    funnel.results = PENDING_RESULTS_HTML;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const res = await GET(healthReq("203.0.113.15"));
    expect(res.status).toBe(503);
    expect((await verdictOf(res)).ok).toBe(false);
    expect(warn.mock.calls.some(([line]) => String(line).includes("verdict=unproven"))).toBe(true);
  });

  it("the pending marker matcher reads the exact attribute the renderer stamps", () => {
    expect(hasCollectionPendingShell(PENDING_RESULTS_HTML)).toBe(true);
    expect(hasCollectionPendingShell(SETTLED_ZERO_RESULTS_HTML)).toBe(false);
    expect(hasCollectionPendingShell(PASS_RESULTS_HTML)).toBe(false);
  });
});
