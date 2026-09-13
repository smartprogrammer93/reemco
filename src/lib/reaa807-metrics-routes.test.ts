/**
 * REEA-807 — route handlers for the weekly snapshot and the link-smoke
 * ingest, exercised as plain Request handlers (no Next runtime needed).
 * Pins: the PM snapshot shape (counter fields only, clicks merged from the
 * funnel store), the ingest validation bounds, and the no-PII payload rule.
 * Dynamic imports so the tmp METRICS_DIR binds before the store module reads it.
 * The funnel store is isolated too (EVENTS_DIR): the default repo store
 * accumulates real dev events whose timestamps land in the CURRENT live ISO
 * week — exactly the week these pins assert on — so an unisolated read makes
 * offer_link_clicks drift with whatever local traffic the repo has seen.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

process.env.METRICS_DIR = mkdtempSync(join(tmpdir(), "reemco-test-metrics-"));
process.env.EVENTS_DIR = mkdtempSync(join(tmpdir(), "reemco-test-events-"));
process.env.KV_REST_API_URL = "";
process.env.KV_REST_API_TOKEN = "";

const { GET: weeklyGET } = await import("@/app/api/metrics/weekly/route");
const { POST: smokePOST } = await import("@/app/api/metrics/link-smoke/route");
const { recordSearchOutcome } = await import("@/lib/metrics");
const { appendEvents } = await import("@/lib/event-store");

const WEEK_MS = Date.UTC(2026, 8, 12); // 2026-W37

function jsonReq(url: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

afterEach(async () => {
  // Fresh week buckets per test: overwrite the W37 counters with empties.
  const { updateWeeklyCounters, emptyWeek } = await import("@/lib/metrics");
  await updateWeeklyCounters((weeks, week) => {
    weeks[week] = emptyWeek();
  }, { now: WEEK_MS });
});

describe("REEA-807 GET /api/metrics/weekly", () => {
  it("returns the PM snapshot: counters plus funnel-derived link clicks, no PII", async () => {
    await recordSearchOutcome(
      { zeroOffers: true, offersByRetailer: {}, serveOutcome: "pending", serveLatencyMs: 4_200, adapterAttempts: { Xcite: 1 }, adapterFailures: { Xcite: 1 } },
      { now: WEEK_MS },
    );
    await recordSearchOutcome(
      { zeroOffers: false, offersByRetailer: { Xcite: 3, Jarir: 2 }, serveOutcome: "full", serveLatencyMs: 1_800, adapterAttempts: { Xcite: 1, Jarir: 1 } },
      { now: WEEK_MS },
    );
    await appendEvents([
      { type: "item_clicked", query: "sony", rank: 0, item_id: "p1", outbound_url: "https://xcite.example/x" },
      { type: "item_clicked", query: "sony", rank: 1, item_id: "p2", outbound_url: "https://jarir.example/x" },
      { type: "search_submitted", query: "sony", result_count: 5 },
    ]);

    const res = await weeklyGET(jsonReq("http://localhost/api/metrics/weekly?weeks=4"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      weeks: Record<string, Record<string, unknown>>;
      retention_weeks: number;
      window_weeks: number;
    };
    const week = body.weeks["2026-W37"] as Record<string, unknown>;
    expect(body.retention_weeks).toBe(26);
    expect(body.window_weeks).toBe(4);
    expect(week.searches).toBe(2);
    expect(week.zero_offer_searches).toBe(1);
    expect(week.offers_by_retailer).toEqual({ Xcite: 3, Jarir: 2 });
    expect(week.offer_link_clicks).toBe(2);
    // REEA-871 — the aggregate extension rides the same payload with the
    // same invariants the store guarantees by construction.
    expect(week.cold_serves_full).toBe(1);
    expect(week.cold_serves_pending).toBe(1);
    expect((week.cold_serves_full as number) + (week.cold_serves_pending as number)).toBe(week.searches);
    const bands = ["latency_band_lt_1s", "latency_band_1_3s", "latency_band_3_10s", "latency_band_gt_10s"] as const;
    expect(bands.reduce((n, b) => n + (week[b] as number), 0)).toBe(week.searches);
    expect(week.retailer_adapter_attempts).toEqual({ Xcite: 2, Jarir: 1 });
    expect(week.retailer_adapter_failures).toEqual({ Xcite: 1 });
    for (const [merchant, attempts] of Object.entries(week.retailer_adapter_attempts as Record<string, number>)) {
      expect((week.retailer_adapter_failures as Record<string, number>)[merchant] ?? 0).toBeLessThanOrEqual(attempts);
    }
    // No PII surface: counters and retailer names only.
    expect(Object.keys(week).sort()).toEqual([
      "cold_serves_full",
      "cold_serves_pending",
      "latency_band_1_3s",
      "latency_band_3_10s",
      "latency_band_gt_10s",
      "latency_band_lt_1s",
      "link_smoke",
      "offer_link_clicks",
      "offers_by_retailer",
      "retailer_adapter_attempts",
      "retailer_adapter_failures",
      "searches",
      "zero_offer_searches",
    ]);
  });

  it("caps the requested window at the retention ceiling", async () => {
    const res = await weeklyGET(jsonReq("http://localhost/api/metrics/weekly?weeks=999"));
    const body = (await res.json()) as { window_weeks: number };
    expect(body.window_weeks).toBe(26);
  });
});

describe("REEA-807 POST /api/metrics/link-smoke", () => {
  it("accepts a valid smoke summary into the weekly counters", async () => {
    const res = await smokePOST(
      jsonReq("http://localhost/api/metrics/link-smoke", {
        checked: 6,
        dead: 1,
        by_retailer: { Xcite: { checked: 6, dead: 1 } },
      }),
    );
    expect(res.status).toBe(202);
    const { readWeeklyCounters } = await import("@/lib/metrics");
    const weeks = await readWeeklyCounters({});
    expect(weeks["2026-W37"].link_smoke).toMatchObject({ runs: 1, checked: 6, dead: 1 });
  });

  it("rejects non-JSON, invalid payloads, and impossible math", async () => {
    expect(
      (await smokePOST(jsonReq("http://localhost/x", { checked: 1 }, { "content-type": "text/plain" }))).status,
    ).toBe(415);
    expect((await smokePOST(jsonReq("http://localhost/x", { checked: -1, dead: 0, by_retailer: {} }))).status).toBe(400);
    expect(
      (await smokePOST(jsonReq("http://localhost/x", { checked: 2, dead: 5, by_retailer: {} }))).status,
    ).toBe(400);
    const tooBig = new Request("http://localhost/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(5 * 1024),
    });
    expect((await smokePOST(tooBig)).status).toBe(413);
  });
});
