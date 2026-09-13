import { describe, expect, it } from "vitest";
import { deviceLeadFlags, deviceLeadSnap, queryHasDeviceIntent, KUWAIT_PRIMARY_MERCHANTS } from "@/lib/collect/coverage";
import { narrowDeviceLead } from "@/lib/relevance";
import type { NormalizedProduct } from "@/types/product";

/* REEA-793 — B1 device-first lead + B2 Kuwait coverage honesty: pure-helper
   pins for the serve-time guard and the derived honesty flags. */

function row(title: string, merchants: string[] = []): NormalizedProduct {
  return {
    productId: title,
    title,
    url: `https://x/${encodeURIComponent(title)}`,
    offers: merchants.map((m, i) => ({
      merchant: m,
      price: 10 + i,
      currency: "KWD",
      url: `https://x/${i}`,
    })),
  } as unknown as NormalizedProduct;
}

describe("REEA-793 device-first serve-time guard", () => {
  it("device-intent query: device rows lead, stored order holds behind them", () => {
    const rows = [row("Case for iPhone 17 Pro"), row("iPhone 17 Pro 256GB"), row("Charger USB-C")];
    const out = narrowDeviceLead("iPhone 17 Pro", rows, (p) => !/Case|Charger/.test(p.title));
    expect(out.map((p) => p.title)).toEqual(["iPhone 17 Pro 256GB", "Case for iPhone 17 Pro", "Charger USB-C"]);
  });

  it("no device row rendered: stored order stands (honest state, no fake lead)", () => {
    const rows = [row("Case for iPhone 17 Pro"), row("Charger USB-C")];
    const out = narrowDeviceLead("iPhone 17 Pro", rows, (p) => !/Case|Charger/.test(p.title));
    expect(out.map((p) => p.title)).toEqual(["Case for iPhone 17 Pro", "Charger USB-C"]);
  });

  it("plain query passes through unchanged; the guard is idempotent", () => {
    const rows = [row("Case"), row("Screen protector")];
    expect(narrowDeviceLead("case", rows, () => false)).toEqual(rows);
    const once = narrowDeviceLead("iPhone 17", [row("Case"), row("iPhone 17")], (p) => p.title === "iPhone 17");
    expect(narrowDeviceLead("iPhone 17", once, (p) => p.title === "iPhone 17")).toEqual(once);
  });

  it("deviceLeadSnap mirrors the predicate form", () => {
    const rows = [row("Case for iPhone 17"), row("iPhone 17 128GB")];
    expect(deviceLeadSnap("iPhone 17", rows)[0].title).toBe("iPhone 17 128GB");
  });
});

describe("REEA-793 honesty flags", () => {
  it("device-intent query with accessories only -> deviceLeadPending", () => {
    const flags = deviceLeadFlags("iPhone 17 Pro", [row("Case for iPhone 17 Pro")]);
    expect(flags.deviceLeadPending).toBe(true);
  });

  it("device rows rendered -> no pending flag", () => {
    const flags = deviceLeadFlags("iPhone 17 Pro", [row("iPhone 17 Pro"), row("Case")]);
    expect(flags.deviceLeadPending).toBe(false);
  });

  it("zero Kuwait-primary offers among rendered rows -> kuwaitPendingStatus", () => {
    const flags = deviceLeadFlags("iPhone 17 Pro", [row("iPhone 17 Pro", ["Amazon"])]);
    expect(flags.kuwaitPendingStatus).toBe(true);
    const ok = deviceLeadFlags("iPhone 17 Pro", [row("iPhone 17 Pro", ["Xcite"])]);
    expect(ok.kuwaitPendingStatus).toBe(false);
  });

  it("empty rendered set flags neither (REEA-437 grammar)", () => {
    expect(deviceLeadFlags("iPhone 17", [])).toEqual({ deviceLeadPending: false, kuwaitPendingStatus: false });
    expect(deviceLeadFlags("case", [row("case")]).deviceLeadPending).toBe(false);
    expect(queryHasDeviceIntent("case")).toBe(false);
  });

  it("REEA-835: kuwaitPendingStatus keys on the rendered set, not the query shape", () => {
    // A non-device first paint must be able to say "no Kuwait answer yet"
    // too — the device-intent gate stays on deviceLeadPending only.
    const nonDevice = deviceLeadFlags("coffee machine", [row("Delonghi coffee machine", ["Amazon"])]);
    expect(nonDevice.kuwaitPendingStatus).toBe(true);
    expect(nonDevice.deviceLeadPending).toBe(false);
    // A Kuwait-primary offer among the rendered rows clears the flag on any query.
    expect(deviceLeadFlags("coffee machine", [row("Delonghi coffee machine", ["Sultan Center"])]).kuwaitPendingStatus).toBe(false);
  });

  it("Kuwait-primary merchant list is the fixed four", () => {
    expect([...KUWAIT_PRIMARY_MERCHANTS]).toEqual(["Xcite", "Jarir", "Eureka", "Sultan Center"]);
  });
});
