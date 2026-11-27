import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// REEA-1262 — production deploys took the only shopper-facing host offline:
// the old single-service deploy stopped the running build before the new one
// could answer, so every push produced ~50 s of 503 / connection-refused.
//
// The fix is blue/green: start the inactive slot alongside the live one, gate
// the proxy switch on the NEW slot answering /api/health + a real search, and
// only stop the old slot after the switched surface verifies. These pins keep a
// future compose/Caddy/script edit from silently reintroducing the gap.
describe("REEA-1262 zero-downtime deploy", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const read = (p: string) => readFileSync(path.join(repoRoot, p), "utf8");

  const compose = read("infra/compose.prod.yml");
  const caddy = read("infra/Caddyfile");
  const deploy = read("infra/scripts/deploy.sh");
  const rollback = read("infra/scripts/rollback.sh");
  const healthUnit = read("infra/systemd/reemco-health.service");
  const workflow = read(".github/workflows/deploy-selfhosted.yml");

  it("ships two app slots on distinct loopback ports and image tags", () => {
    expect(compose).toMatch(/^\s*app: &app-service$/m);
    expect(compose).toMatch(/^\s*app_green:$/m);
    expect(compose).toContain("REEMCO_IMAGE_TAG_GREEN");
    expect(compose).toContain('"127.0.0.1:3000:3000"');
    expect(compose).toContain('"127.0.0.1:3001:3000"');
  });

  it("routes Caddy through the active-slot placeholder, not a hardcoded service", () => {
    expect(caddy).toContain("reverse_proxy {$REEMCO_APP_UPSTREAM:app:3000}");
    expect(caddy).not.toMatch(/reverse_proxy app:3000/);
  });

  it("serves a readable 503 with Retry-After instead of an empty body", () => {
    // AC-4: both the app-generated 5xx (handle_response) and Caddy's own
    // no-upstream error (handle_errors) must carry Retry-After and a page.
    expect(caddy).toContain("handle_errors");
    expect(caddy).toMatch(/@app5xx status 500 502 503 504/);
    expect(caddy.match(/Retry-After "5"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(caddy).toContain("<!doctype html>");
  });

  it("waits for health AND a real search on the new slot before switching", () => {
    // AC-2: no request may be served by a build that cannot answer.
    const readyAt = deploy.indexOf("wait_ready \"$TARGET\" \"$TAG\"");
    const switchAt = deploy.indexOf("if ! switch_upstream \"$TARGET\"");
    expect(readyAt).toBeGreaterThan(-1);
    expect(switchAt).toBeGreaterThan(-1);
    expect(readyAt).toBeLessThan(switchAt);
    // The readiness probe must assert the commit stamp, /api/health and a
    // search on the slot's own port.
    expect(deploy).toContain("/__commit.txt");
    expect(deploy).toContain("/api/health");
    expect(deploy).toContain("/results?q=iphone+17+pro");
    expect(deploy).toMatch(/slot_port\(\)/);
  });

  it("leaves the old slot serving when the new one never becomes ready", () => {
    // AC-3: a failed deploy stops the target slot and never switches.
    const readyBlock = deploy.slice(
      deploy.indexOf("if ! wait_ready \"$TARGET\" \"$TAG\"; then"),
      deploy.indexOf("if ! switch_upstream \"$TARGET\"; then"),
    );
    expect(readyBlock).toContain('compose stop "$TARGET"');
    expect(readyBlock).not.toContain("compose stop \"$ACTIVE\"");
  });

  it("stops the old slot only after the switched surface verified", () => {
    const verifyAt = deploy.indexOf("/opt/reemco/scripts/verify.sh --tag \"$TAG\"");
    const stopOldAt = deploy.indexOf('compose stop "$ACTIVE" >>"$LOG" 2>&1 || log');
    expect(verifyAt).toBeGreaterThan(-1);
    expect(stopOldAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeLessThan(stopOldAt);
  });

  it("rolls back through the same engine instead of a second code path", () => {
    expect(rollback).toContain(
      'exec /opt/reemco/scripts/deploy.sh --tag "$TAG" --mode rollback',
    );
  });

  it("keeps the scheduled health probe pointed at the active slot", () => {
    expect(healthUnit).toContain("ExecStart=/opt/reemco/scripts/health-probe.sh");
    expect(healthUnit).not.toContain("127.0.0.1:3000/api/health");
  });

  it("syncs every script the deploy path now needs", () => {
    expect(workflow).toContain("infra/scripts/health-probe.sh");
    expect(workflow).toContain("infra/scripts/deploy.sh");
    expect(workflow).toContain("infra/scripts/rollback.sh");
  });
});
