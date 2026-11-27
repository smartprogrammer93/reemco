/**
 * REEA-1270 (Bet 3) R-4 — the correction IS the dispatch: the Bet 8 alias
 * rule ("one dispatch spelling") is the model, so the corrected spelling is
 * the spelling every adapter hop and the served snapshot read. No second cold
 * fan-out is added, and the typed typo is never dispatched alongside it.
 *
 * The harness mirrors the REEA-437 dispatch tests: an injected fetchImpl is
 * the only hop that answers, so the assertions read exactly what the run sent.
 */
import "./test-cache-dir";
import { describe, expect, it } from "vitest";
import { collectLiveResults, resetDiscoveryCache } from "@/lib/collect/live-search";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}
const xciteEnvelope = (hits: Record<string, unknown>[]) => ({ results: [{ hits }] });
const xciteQuery = (init?: RequestInit): string => {
  const body = JSON.parse(String(init?.body ?? "{}")) as {
    requests?: { params?: { query?: string } }[];
  };
  return body.requests?.[0]?.params?.query ?? "";
};

describe("REEA-1270 R-4 — one dispatch spelling, no second cold fan-out", () => {
  it("dispatches the corrected spelling and serves its live rows", async () => {
    resetDiscoveryCache();
    const queries: string[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      const query = xciteQuery(init);
      queries.push(query);
      // The retailers reject the typo; the corrected spelling answers.
      if (query === "iphone 17 pro") {
        return jsonResponse(
          xciteEnvelope([
            { name: "Apple iPhone 17 Pro 256GB", slug: "iphone17pro", price: 469, currency: "KWD", inStock: true },
          ]),
        );
      }
      return jsonResponse({});
    };

    const { products, correction } = await collectLiveResults("iphon 17 pro", { fetchImpl });

    expect(correction).toEqual({
      from: "iphon 17 pro",
      to: "iphone 17 pro",
      tokens: [{ from: "iphon", to: "iphone" }],
    });
    // The corrected spelling's live rows ARE the served answer, and the scope
    // gate stamped them against the spelling the retailers answered.
    expect(products.length).toBeGreaterThan(0);
    expect(products[0].title).toContain("iPhone 17 Pro");
    expect(["primary", "variant"]).toContain(products[0].productScope);
    expect(products[0].matchReason).not.toBe("related");
    // One dispatch spelling: the typo is never sent to a retailer.
    expect(queries).toContain("iphone 17 pro");
    expect(queries).not.toContain("iphon 17 pro");
  });

  it("a query with no near miss keeps the shipped trimmed-token retry", async () => {
    resetDiscoveryCache();
    const queries: string[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      const query = xciteQuery(init);
      queries.push(query);
      if (query === "lg gram mini") return jsonResponse(xciteEnvelope([]));
      if (query === "lg gram") {
        return jsonResponse(
          xciteEnvelope([
            { name: "LG gram 16 Notebook", slug: "lg16", price: 299, currency: "KWD", inStock: true },
          ]),
        );
      }
      return jsonResponse({});
    };

    const { products, attemptedQueries, correction } = await collectLiveResults("lg gram mini", {
      fetchImpl,
    });

    expect(correction).toBeUndefined();
    expect(attemptedQueries).toEqual(["lg gram mini", "lg gram"]);
    expect(products.length).toBeGreaterThan(0);
  });

  it("re-spells the typo on the dispatch, so the page can name it explicitly", async () => {
    resetDiscoveryCache();
    const queries: string[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      const query = xciteQuery(init);
      queries.push(query);
      if (query === "samsung s25") {
        return jsonResponse(
          xciteEnvelope([
            { name: "Samsung Galaxy S25 256GB", slug: "s25", price: 319, currency: "KWD", inStock: true },
          ]),
        );
      }
      return jsonResponse({});
    };

    const { products, correction } = await collectLiveResults("samsng s25", { fetchImpl });

    expect(correction?.to).toBe("samsung s25");
    expect(products.length).toBeGreaterThan(0);
    expect(queries).toContain("samsung s25");
    expect(queries).not.toContain("samsng s25");
  });

  it("stamps the correction on the served snapshot so the empty state names it too", async () => {
    resetDiscoveryCache();
    const fetchImpl = async (): Promise<Response> => jsonResponse(xciteEnvelope([]));

    const { products, correction, attemptedQueries } = await collectLiveResults(
      "samsung washing mashine",
      { fetchImpl },
    );

    expect(products).toHaveLength(0);
    expect(correction?.to).toBe("samsung washing machine");
    // The empty state names what the run actually issued (the corrected form
    // and its bounded widening) — never the silent substitution.
    expect(attemptedQueries?.[0]).toBe("samsung washing machine");
  });
});
