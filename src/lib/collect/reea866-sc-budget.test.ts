/**
 * REEA-866 — Sultan Center rides the SHARED per-retailer budget; the REEA-264
 * per-lane ~2 s exception (SC_LANE_TIMEOUT_MS / laneCeilingFor) is retired.
 *
 * W37 evidence (REEA-861 metrics-read-1 → REEA-866): Sultan Center served
 * 4 offers while every other adapter served 1,473–20,180. Root cause on the
 * live edge: the storefront's mobile/api/search answers in ~1.4–3.5 s
 * (median ~3 s, 13 live samples), so the 2 s lane window aborted the phrase
 * round ~70% of the time AND the REEA-290 retry's own 2 s window the same
 * way — the "cut hop retries warm behind the finalize clock" design assumed
 * ~150 ms warm replays, but live warm answers still cost seconds. The cap's
 * original reason (SC as last arranger gating the full-set render,
 * REEA-257) died with the completion-budget staged render (REEA-693/756):
 * the page finalizes on its own clock and late rows fold in through the
 * follow-up feed, so a slow lane can no longer gate anything.
 *
 * Guardrails encoded here:
 *  - no per-lane exception survives: SC hosts ride the shared
 *    PER_RETAILER_TIMEOUT_MS on both the runner and the staged results path;
 *  - on the runner path a SC hop answering at ~2.4 s (the exact shape the
 *    old cap cut) now LANDS, while a hop still silent past the shared
 *    budget is cut toward the retry chip exactly as any other lane;
 *  - on the staged results path a ~3 s SC answer (median live shape, cut by
 *    the old cap) reaches the converged snapshot in a single window;
 *  - a fast SC answer stays a single round-trip — no needless retry;
 *  - data stays live-fetched: every assertion reads stub-served rows only.
 */
import "./test-cache-dir";
import { describe, expect, it } from "vitest";
import { PER_RETAILER_TIMEOUT_MS } from "@/lib/collect/types";
import { scrapeOffer } from "@/lib/collect/scraper";
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

describe("REEA-866 Sultan Center shared lane budget", () => {
  it("keeps no per-lane exception: SC hosts ride the shared per-retailer budget", async () => {
    // The retired symbols must stay retired — the shared budget is the only
    // ceiling on every lane again (adapter symmetry, REEA-866).
    const types = await import("@/lib/collect/types");
    expect("SC_LANE_TIMEOUT_MS" in types).toBe(false);
    const scraper = await import("@/lib/collect/scraper");
    expect("laneCeilingFor" in scraper).toBe(false);
    expect(PER_RETAILER_TIMEOUT_MS).toBe(4_000);
  });

  it("runner path: a SC hop answering at ~2.4s LANDS (the shape the old 2s cap cut)", async () => {
    // Late-but-answerable store: answers at ~2.4 s — inside the shared 4 s
    // budget, and exactly the round the REEA-264 cap aborted into a retry.
    const outcome = await scrapeOffer(scOffer, {
      fetchImpl: slowFetch(2_400, okHtml),
    });
    expect(outcome.timedOut).toBeUndefined();
    expect(outcome.offers[0]).toMatchObject({ merchant: "Sultan Center", price: 11.5 });
  }, 10_000);

  it("runner path: a SC hop silent past the shared budget is cut like any other lane", async () => {
    const outcome = await scrapeOffer(scOffer, {
      fetchImpl: slowFetch(4_400, okHtml),
    });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.error).toBe("Timed out after 4s");
    expect(outcome.offers).toHaveLength(0);
  }, 10_000);

  it("runner path: a late-but-in-budget answer on another lane is untouched", async () => {
    const outcome = await scrapeOffer(otherOffer, {
      fetchImpl: slowFetch(2_400, okHtml),
    });
    expect(outcome.timedOut).toBeUndefined();
    expect(outcome.offers[0]).toMatchObject({ merchant: "Xcite", price: 11.5 });
  }, 10_000);

  it("results path: a ~3s SC answer (median live shape, cut by the old cap) reaches the converged snapshot", async () => {
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
      if (url.includes("sultan-center.com")) return slowFetch(3_000, sultanBody, calls)(url, init);
      return new Response(JSON.stringify({}), { status: 200 });
    };
    // Generous finalize window so the assertion sees the CONVERGED tail, not
    // the 1.8 s stream close: the ~3 s answer lands behind the finalize and
    // folds in through the follow-up feed exactly as the staged design says.
    const staged = collectLiveResultsStaged("nescafe coffee", { fetchImpl, deadlineMs: 9_000 });
    const snap = await staged.final;
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
    expect(calls.n).toBe(1); // no needless retry when the hop lands inside the budget
  }, 15_000);
});
