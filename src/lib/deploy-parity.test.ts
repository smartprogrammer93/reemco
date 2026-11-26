import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parity: any = await import("../../scripts/parity-check.mjs");

// REEA-1233 — the deploy parity invariant must be checked, not discovered by
// hand. These pins keep three things honest:
//   1. the classification thresholds (15-minute window) cannot drift silently;
//   2. funnel-smoke step 6 stays an ADVISORY, retried/backoff signal so a
//      third-party retailer flake cannot pin production behind origin/main;
//   3. the deploy workflow prints the canonical PARITY line and the scheduled
//      tripwire alerts on a failed/cancelled deploy run for the head, even
//      inside the window (the gap that let fresh rollbacks hide).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

describe("REEA-1233 parity invariant classification", () => {
  it("is in sync when served == origin/main", () => {
    const r = parity.classifyParity({ served: "a".repeat(40), expected: "a".repeat(40), lagMinutes: 99 });
    expect(r).toMatchObject({ status: "IN_SYNC", ok: true });
  });

  it("accepts lag inside the 15-minute window and rejects lag beyond it", () => {
    expect(parity.classifyParity({ served: "a".repeat(40), expected: "b".repeat(40), lagMinutes: 15 })).toMatchObject({
      status: "BEHIND_WITHIN_WINDOW",
      ok: true,
    });
    expect(parity.classifyParity({ served: "a".repeat(40), expected: "b".repeat(40), lagMinutes: 16 })).toMatchObject({
      status: "BEHIND",
      ok: false,
    });
  });

  it("treats an unknown head age as behind, and an unreadable stamp as unmeasurable", () => {
    expect(parity.classifyParity({ served: "a".repeat(40), expected: "b".repeat(40), lagMinutes: null })).toMatchObject({
      status: "BEHIND_UNKNOWN_AGE",
      ok: false,
    });
    expect(parity.classifyParity({ served: "", expected: "b".repeat(40), lagMinutes: 1 })).toMatchObject({
      status: "UNMEASURABLE",
      ok: false,
    });
  });

  it("defaults the window to 15 minutes", () => {
    expect(parity.DEFAULT_MAX_LAG_MIN).toBe(15);
  });
});

describe("REEA-1233 gate wiring", () => {
  const smoke = read("scripts/smoke-check.mjs");
  const deploy = read(".github/workflows/deploy-selfhosted.yml");
  const tripwire = read(".github/workflows/stamp-parity.yml");
  const pkg = JSON.parse(read("package.json"));

  it("link-health is advisory, retried with backoff, and never throws by default", () => {
    expect(smoke).toContain("ADVISORY since REEA-1233");
    expect(smoke).toContain("RETRY_BACKOFF_MS");
    expect(smoke).toContain("LINK_HEALTH_BLOCKING");
    expect(smoke).toContain("::warning::link-health is advisory");
    expect(smoke).not.toContain("offer URL(s) dead");
  });

  it("the deploy workflow prints the canonical parity line at the 15-minute threshold", () => {
    expect(deploy).toContain("name: Deploy parity invariant (served vs origin/main)");
    expect(deploy).toContain("npm run parity");
    expect(deploy).toContain('PARITY_MAX_LAG_MIN: "15"');
  });

  it("the tripwire alerts on a failed/cancelled deploy run for the head inside the window", () => {
    expect(tripwire).toContain("acceptable lag between origin/main");
    expect(tripwire).toMatch(/\$RUN_CONCL" != "failure"/);
    expect(tripwire).toContain("npm run parity");
  });

  it("exposes the invariant to QA and the lanes as npm run parity", () => {
    expect(pkg.scripts.parity).toBe("node scripts/parity-check.mjs");
  });
});
