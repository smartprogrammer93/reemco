import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

// REEA-1084 (F7a) — info disclosure: Next sends `X-Powered-By: Next.js` on every
// response by default. It does not leak a version and has no exploit path, but
// it hands an attacker the framework for free, which is exactly the kind of
// cheap fingerprinting this hardening pass removes. The fix is one config key;
// the regression risk is that a future config rewrite drops it silently (the
// header is invisible in the UI and no browser test would notice), so pin the
// resolved config value AND the two wire-level gates that assert it.
//
// On 682f3db (the pre-fix deployed tag) `poweredByHeader` is absent, i.e.
// `undefined` — this suite fails there, which is the regression test.
describe("REEA-1084 X-Powered-By suppression", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const read = (rel: string) => readFileSync(path.join(repoRoot, rel), "utf8");

  it("disables the framework banner in next.config.ts", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it("gates the served header on the host with verify.sh", () => {
    const verify = read("infra/scripts/verify.sh");
    // Blocking, not advisory: `fail` exits non-zero and deploy.sh treats a
    // failed verify as a failed deploy (auto-rollback).
    expect(verify).toContain(
      'printf \'%s\\n\' "$HEADERS" | grep -iq "^x-powered-by:" && fail "X-Powered-By leaked"',
    );
    // The assertion must sit inside step 2 (security headers), not in a block
    // that is skipped when docker is unavailable.
    const step2 = verify.indexOf("# 2. Security headers.");
    const step3 = verify.indexOf("# 3. Health through the proxy");
    expect(step2).toBeGreaterThan(-1);
    expect(step3).toBeGreaterThan(step2);
    const block = verify.slice(step2, step3);
    expect(block).toContain("x-powered-by");
  });

  it("gates the public surface in the self-hosted deploy workflow", () => {
    const workflow = read(".github/workflows/deploy-selfhosted.yml");
    const start = workflow.indexOf("name: Verify public surface");
    const end = workflow.indexOf("name: Funnel smoke check", start);
    expect(start).toBeGreaterThan(-1);
    const step = start === -1 ? "" : workflow.slice(start, end);
    expect(step).toContain("x-powered-by");
    expect(step).toContain("exit 1");
  });
});

// REEA-1275 — first-card paint was tried with `experimental.inlineCss`, but
// the route stylesheet is a ~100 KB bundle and Next duplicates an inlined
// stylesheet once in `<style>` and once in the RSC payload (the documented
// trade-off). On the served head that added ~200 KB to the document and moved
// the first card the WRONG way. The stylesheet stays external; the first-card
// win is the trimmed flush payload. Pin the flag OFF so a future config
// rewrite does not silently re-inline it.
describe("REEA-1275 inlineCss", () => {
  it("keeps the route CSS external", () => {
    expect(nextConfig.experimental?.inlineCss).not.toBe(true);
  });
});
