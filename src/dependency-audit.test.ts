/**
 * REEA-1134 F2 — lockfile pin for the dev-only minimatch DoS advisory.
 *
 * GHSA-g3hv-75wg-m249 (CWE-405, globparts amplification) affects
 * `minimatch >=7.0.0 <11.0.1`. On the live build (REEA-1121 finding F2) the
 * only reachable path was eslint → minimatch 10.2.6, i.e. dev-only: the
 * production graph (`npm audit --omit=dev`) was already clean, so this was
 * never a runtime vulnerability. The fix is the eslint 10.15.0 bump (its
 * minimatch range is ^11.0.5), which resolves the whole tree to 11.0.9.
 *
 * This pin is the offline equivalent of the "npm audit --omit=dev stays 0"
 * regression check: it reads the committed lockfile (the artifact the
 * self-hosted deploy builds from) and fails if ANY minimatch resolution
 * falls back into the advisory range, or if eslint's declared minimatch
 * range could resolve to a vulnerable version. It also keeps the CI
 * production-audit gate from being silently dropped — a dropped gate is
 * invisible until a bad push (the REEA-1067 lesson).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** GHSA-g3hv-75wg-m249: vulnerable range is >=7.0.0 <11.0.1. */
const ADVISORY_MIN: Version = [7, 0, 0];
const ADVISORY_MAX: Version = [11, 0, 1];

type Version = [number, number, number];

function parseVersion(raw: unknown): Version | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function inAdvisoryRange(version: Version): boolean {
  return compare(version, ADVISORY_MIN) >= 0 && compare(version, ADVISORY_MAX) < 0;
}

const lock = JSON.parse(readFileSync(path.join(repoRoot, "package-lock.json"), "utf8")) as {
  packages?: Record<string, { version?: string; dependencies?: Record<string, string> }>;
};
const packages = lock.packages ?? {};

const minimatchEntries = Object.entries(packages).filter(([key]) => /(^|\/)minimatch$/.test(key));

const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "deploy-selfhosted.yml"), "utf8");

describe("REEA-1134 F2 minimatch advisory (GHSA-g3hv-75wg-m249)", () => {
  it("resolves every minimatch in the lockfile to a patched version", () => {
    expect(minimatchEntries.length).toBeGreaterThan(0);
    const vulnerable = minimatchEntries
      .map(([key, entry]) => ({ key, version: parseVersion(entry.version) }))
      .filter((entry): entry is { key: string; version: Version } => entry.version !== null)
      .filter((entry) => inAdvisoryRange(entry.version));
    expect(vulnerable).toEqual([]);
  });

  it("eslint declares a minimatch range that cannot resolve into the advisory range", () => {
    const eslint = packages["node_modules/eslint"];
    expect(eslint).toBeDefined();
    // eslint >=10.15.0 is the first 10.x line on minimatch ^11.0.5; its floor
    // must stay at or above the patched 11.0.1.
    const declared = eslint?.dependencies?.minimatch;
    const floor = parseVersion(declared?.replace(/^[\^~>=<\s]*/, ""));
    expect(floor).not.toBeNull();
    expect(compare(floor as Version, [11, 0, 1] as Version)).toBeGreaterThanOrEqual(0);
    // And the resolved eslint is the bumped one (defence in depth: a stale
    // lockfile entry with an old range would still pass the floor check).
    expect(compare(parseVersion(eslint?.version) as Version, [10, 15, 0] as Version)).toBeGreaterThanOrEqual(0);
  });

  it("CI keeps the production dependency audit gate before the image build", () => {
    expect(workflow).toContain("npm audit --omit=dev --audit-level=high");
    // The gate must run before the artifact build, not after it.
    expect(workflow.indexOf("npm audit --omit=dev --audit-level=high")).toBeLessThan(
      workflow.indexOf("docker build -f infra/Dockerfile"),
    );
  });
});
