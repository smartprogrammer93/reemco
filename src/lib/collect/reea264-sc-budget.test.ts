/**
 * REEA-264 — Sultan Center effective per-adapter budget on the deployed
 * paths. Tail attribution (REEA-257): SC answers avg ~3.5-3.6 s, under the
 * shared 4 s per-adapter ceiling, yet the lane gated the full-set render
 * (p90 stuck ~4.9 s). Guardrails encoded here:
 *  - the SC lane's effective ceiling is ~2 s, every OTHER lane keeps the
 *    shared PER_RETAILER_TIMEOUT_MS (adapter symmetry — one documented
 *    exception, not a new default);
 *  - on the runner path a cut SC hop lands as a `timedOut` subtask inside
 *    the ~2 s cap, while a slow-but-under-cap hop on another lane still
 *    answers normally;
 *  - on the staged results path a cut SC hop retries once behind the
 *    finalize clock and the live rows still reach the converged snapshot
 *    (progressive flush), a fast SC answer stays a single round-trip;
 *  - data stays live-fetched: every assertion reads stub-served rows only.
 */
import "./test-cache-dir";
import { describe, expect, it } from "vitest";
import { PER_RETAILER_TIMEOUT_MS, SC_LANE_TIMEOUT_MS } from "@/lib/collect/types";
import { laneCeilingFor, scrapeOffer } from "@/lib/collect/scraper";
import { collectLiveResultsStaged } from "@/lib/collect/live-search";

const okHtml = '<script type="application/ld+json">{"price":"11.5"}</script>';

/** Fetch stub that HONORS the abort signal: first call answers after
 *  `delayMs`, repeats answer fast — the measured shape of the storefront's
 *  cold-first-call / warm-replay line (REA-416). */
function slowFetch(delayMs: number, body: string, calls?: { n: number }) {
  return (url: string, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      const first = calls ? calls.n === 0 : true;
      if (calls) calls.n += 1;
      const waitMs = first ? delayMs : 150;
      const signal = init?.signal;
      const abortError = () =>
        Object.assign(new Error("signal aborted"), { name: "AbortError" });
      if (signal?.aborted) return reject(abortError());
      const onAbort = () => reject(abortError());
      signal?.addEventListener("abort", onAbort, { once: true });
      setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve(new Response(body, { status: 200 }));
      }, waitMs);
    });
}

const scOffer = {
  merchant: "Sultan Center",
  url: "https://www.sultan-center.com/product/nescafe-classic",
  currency: "KWD",
};
const otherOffer = {
  merchant: "Xcite",
  url: "https://www.xcite.com/p/nescafe-classic",
  currency: "KWD",
};

describe("REEA-264 Sultan Center lane budget", () => {
  it("caps only the Sultan Center lane at ~2s; others keep the shared budget", () => {
    expect(SC_LANE_TIMEOUT_MS).toBe(2_000);
    expect(laneCeilingFor("sultan-center.com")).toBe(SC_LANE_TIMEOUT_MS);
    expect(laneCeilingFor("www.sultan-center.com")).toBe(SC_LANE_TIMEOUT_MS);
    expect(laneCeilingFor("xcite.com")).toBe(PER_RETAILER_TIMEOUT_MS);
    expect(laneCeilingFor("jarir.com")).toBe(PER_RETAILER_TIMEOUT_MS);
  });

  it("runner path: a SC hop still silent at ~2s is cut toward the retry chip", async () => {
    // Late-but-answerable store: answers at ~2.4 s — inside the OLD shared
    // 4 s cap, exactly the REEA-257 tail shape. The lane cap must cut it.
    const outcome = await scrapeOffer(scOffer, {
      fetchImpl: slowFetch(2_400, okHtml),
    });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.error).toBe("Timed out after 2s");
    expect(outcome.offers).toHaveLength(0);
  }, 10_000);

  it("runner path: a late-but-in-budget answer on another lane is untouched", async () => {
    // Same 2.4 s shape, non-SC host: under PER_RETAILER_TIMEOUT_MS, so the
    // offer must land exactly as before the lane cap existed.
    const outcome = await scrapeOffer(otherOffer, {
      fetchImpl: slowFetch(2_400, okHtml),
    });
    expect(outcome.timedOut).toBeUndefined();
    expect(outcome.offers[0]).toMatchObject({ merchant: "Xcite", price: 11.5 });
  }, 10_000);

  it("results path: a cut SC hop retries behind the finalize clock and still feeds the converged snapshot", async () => {
    const calls = { n: 0 };
    const sultanBody = JSON.stringify({
      status: "1",
      products: {
        product_list: [
          { name: "Nescafe Classic Coffee 50g", slug: "nescafe-classic", price: "2.400", is_in_stock: "1" },
        ],
      },
    });
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("sultan-center.com")) return slowFetch(2_400, sultanBody, calls)(url, init);
      return new Response(JSON.stringify({}), { status: 200 });
    };
    // Generous finalize window so the assertion sees the CONVERGED tail:
    // attempt one dies on the ~2s lane cap, the bounded retry answers warm.
    const staged = collectLiveResultsStaged("nescafe coffee", { fetchImpl, deadlineMs: 9_000 });
    const snap = await staged.final;
    const scNote = snap.notes.find((n) => n.merchant === "Sultan Center");
    expect(scNote).toBeDefined();
    expect(scNote!.hits).toBeGreaterThanOrEqual(1);
    expect(calls.n).toBeGreaterThanOrEqual(2); // cut happened, retry answered
    // The live rows themselves are served — stub data, live-fetched only.
    expect(snap.products.some((p) => p.offers.some((o) => o.merchant === "Sultan Center"))).toBe(true);
  }, 15_000);

  it("results path: a fast SC answer stays a single round-trip", async () => {
    const calls = { n: 0 };
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("sultan-center.com")) return slowFetch(60, JSON.stringify({
        products: { product_list: [{ name: "Nescafe Classic Coffee 50g", slug: "nescafe-classic", price: "2.400", is_in_stock: "1" }] },
      }), calls)(url, init);
      return new Response(JSON.stringify({}), { status: 200 });
    };
    const staged = collectLiveResultsStaged("nescafe coffee", { fetchImpl });
    const snap = await staged.final;
    const scNote = snap.notes.find((n) => n.merchant === "Sultan Center");
    expect(scNote!.hits).toBeGreaterThanOrEqual(1);
    expect(calls.n).toBe(1); // no needless retry when the hop lands inside the cap
  }, 15_000);
});
