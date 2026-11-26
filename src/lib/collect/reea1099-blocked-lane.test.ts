/**
 * REEA-1099 AC4 — a dispatched lane that returns no usable payload
 * (Cloudflare 403 / challenge / zone-blocked) counts as an adapter failure.
 *
 * Live defect (W48 payload on `50cc3ae`): Lulu Hypermarket had 2,096
 * `retailer_adapter_attempts` and NO `retailer_adapter_failures` entry while
 * the results page named it `Unreachable: Lulu Hypermarket.` — the lane was
 * dispatched, answered with a challenge shell, and its silent zero read as a
 * healthy lane in the plan's failure-share guardrail.
 *
 * Pins:
 *  - a blocked answer settles as a failure and is NOT retried (a zone block is
 *    terminal; the REEA-290 retry would only re-pay the handshake);
 *  - a generic retailer blip still gets its REEA-290 second attempt;
 *  - the fan-out telemetry records Lulu as a failure while a healthy lane stays
 *    at zero failures — the aggregate-only shape the plan reads;
 *  - the shopper copy is unchanged: the blocked lane is named UNREACHABLE, not
 *    also "No response" (REEA-1078 AC9).
 */
import { describe, expect, it } from "vitest";
import { BlockedLaneError, collectLiveResultsStaged, collectSettled } from "@/lib/collect/live-search";
import { coverageLine } from "@/lib/collect/coverage";

const BLOCK_SHELL =
  '<html><head><title>Attention Required! | Cloudflare</title></head><body>Enable JavaScript and cookies to continue</body></html>';

/** URL-routed fake egress: Lulu's zone serves a challenge shell, everything
 *  else answers the JSON shape (which parses to zero hits, not an error). */
function egress() {
  const urls: string[] = [];
  const impl = (async (url: string) => {
    const u = String(url);
    urls.push(u);
    if (u.includes("luluhypermarket.com") || u.startsWith("http://")) {
      return new Response(BLOCK_SHELL, { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, urls };
}

/** The collector shape `collectSettled` accepts (its parameter type). */
type RetailerCollector = Parameters<typeof collectSettled>[0];

describe("REEA-1099 blocked-lane failure accounting", () => {
  it("settles a blocked lane as a failure without the retry", async () => {
    let calls = 0;
    const collector: RetailerCollector = {
      merchant: "Lulu Hypermarket",
      country: "KW",
      collect: async () => {
        calls += 1;
        throw new BlockedLaneError();
      },
    };
    const settled = await collectSettled(collector, "iphone 17", egress().impl);
    expect(calls).toBe(1);
    expect(settled.hits).toEqual([]);
    expect(settled.error).toMatch(/blocked/i);
  });

  it("still retries a generic retailer blip once (REEA-290 unchanged)", async () => {
    let calls = 0;
    const collector: RetailerCollector = {
      merchant: "Xcite",
      country: "KW",
      collect: async () => {
        calls += 1;
        throw new Error("HTTP 503");
      },
    };
    const settled = await collectSettled(collector, "iphone 17", egress().impl);
    expect(calls).toBe(2);
    expect(settled.error).toBe("HTTP 503");
  });

  it("records Lulu as a failure while a healthy lane stays at zero", async () => {
    const { impl } = egress();
    // REEA-1207 - Lulu is retired from the default fan-out now; this test is
    // about the blocked-lane settle, so the canary-readmitted lane is injected.
    const staged = collectLiveResultsStaged("iphone 17", {
      fetchImpl: impl,
      country: "KW",
      deadlineMs: 120,
      readmittedLanes: ["Lulu Hypermarket"],
    });
    await staged.allSettled;
    const telemetry = await staged.adapterTelemetry;
    expect(telemetry.attempts["Lulu Hypermarket"]).toBe(1);
    expect(telemetry.failures["Lulu Hypermarket"]).toBe(1);
    // Healthy lane unchanged: dispatched, answered, no failure recorded.
    expect(telemetry.attempts["Xcite"]).toBe(1);
    expect(telemetry.failures["Xcite"]).toBeUndefined();
  });

  it("keeps the shopper copy unchanged: unreachable is never also 'No response'", () => {
    const line = coverageLine(
      [
        { merchant: "Lulu Hypermarket", hits: 0, error: "blocked: no usable payload (Cloudflare 403/challenge)" },
        { merchant: "Xcite", hits: 4 },
      ],
      "en",
      [{ productId: "p", title: "iPhone", offers: [{ merchant: "Xcite" }] } as never],
      ["Lulu Hypermarket"],
    );
    expect(line).toContain("Unreachable: Lulu Hypermarket.");
    expect(line).not.toContain("No response");
  });
});
