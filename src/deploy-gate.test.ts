import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// REEA-1067 — the self-hosted deploy must not reach production on `next build`
// alone. The retired Vercel `buildCommand` ran `npm run lint` and the full
// suite first; after the REEA-1054 cutover that gate was gone. The gate now
// lives in `.github/workflows/deploy-selfhosted.yml` as a push-triggered CI
// step BEFORE the on-box `docker build`. This pin keeps a future workflow edit
// from silently dropping it (a dropped gate is invisible until a bad push).
//
// Note: the gate intentionally runs in CI, not in `infra/Dockerfile`, because
// `.dockerignore` excludes `.github` while `src/ci-secrets.test.ts` reads
// `.github/workflows/deploy.yml` — an in-image run would need a widened build
// context to be meaningful. If that ever changes, move this pin with the gate.
describe("REEA-1067 deploy build gate", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const workflow = readFileSync(
    path.join(repoRoot, ".github", "workflows", "deploy-selfhosted.yml"),
    "utf8",
  );

  const gateStart = workflow.indexOf("name: Build gate");
  const resolveStart = workflow.indexOf("name: Resolve the tag to deploy", gateStart);
  const gate = gateStart === -1 ? "" : workflow.slice(gateStart, resolveStart);

  it("has a blocking lint + full-suite gate before the image build", () => {
    expect(gateStart).toBeGreaterThan(-1);
    expect(gate).toContain("npm run lint");
    // Empty KV vars: the kv-store contract expects them empty, matching the
    // retired Vercel buildCommand exactly (AGENTS.md CI-parity rule).
    expect(gate).toContain(
      "NODE_ENV=test KV_REST_API_URL= KV_REST_API_TOKEN= npm run test",
    );
    expect(gate).toContain("set -euo pipefail");

    const installAt = workflow.indexOf("run: npm ci");
    const buildAt = workflow.indexOf("docker build -f infra/Dockerfile");
    expect(installAt).toBeGreaterThan(-1);
    expect(buildAt).toBeGreaterThan(-1);
    expect(installAt).toBeLessThan(gateStart);
    expect(gateStart).toBeLessThan(buildAt);
  });

  it("runs on every push and is skipped only for an explicit rollback", () => {
    expect(gate).toContain(
      "if: github.event_name == 'push' || inputs.rollback_sha == ''",
    );
    // A rollback redeploys a previously verified artifact; the smoke step
    // still needs node_modules, so the install must stay unconditional.
    expect(workflow.indexOf("run: npm ci")).toBeLessThan(gateStart);
  });
});
