import { describe, expect, it } from "vitest";
import { collectLiveResults, resetDiscoveryCache } from "@/lib/collect/live-search";

describe("REAA-408 live merchant hops", () => {
  it("answers the fixed query set cells through the real hops", async () => {
    resetDiscoveryCache();
    const out: Record<string, unknown> = {};
    for (const q of ["أرز بسمتي", "iPhone 17 Pro"]) {
      const { notes } = await collectLiveResults(q, {});
      out[q] = notes.map((n) => `${n.merchant}:${n.hits}${n.error ? `(${n.error})` : ""}`);
    }
    console.log(JSON.stringify(out, null, 1));
    expect(Object.keys(out)).toHaveLength(2);
  }, 60000);
});
