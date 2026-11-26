/**
 * REEA-1233 — deploy parity invariant, readable by QA and every lane.
 *
 * The invariant this measures: the production box must serve the current
 * `origin/main` head. The maximum acceptable lag is PARITY_MAX_LAG_MIN
 * (default 15 minutes — one stamp-parity detection window). Beyond that the
 * scheduled Stamp parity tripwire (`.github/workflows/stamp-parity.yml`)
 * opens/appends the deduped `stamp-parity-alert` issue naming the failing
 * deploy run, and production keeps serving the last good artifact until a
 * green deploy catches up.
 *
 * Why a script instead of each ticket discovering the lag by hand: QA and the
 * coder lanes can run `npm run parity` (or `node scripts/parity-check.mjs`)
 * and read one canonical line. The deploy workflow prints the same line into
 * its job summary, so the parity state is visible next to the deploy that
 * produced it. Read-only: this script never deploys or mutates anything.
 *
 * Usage:
 *   node scripts/parity-check.mjs                 # origin/main from git or GitHub
 *   EXPECTED_SHA=<sha> node scripts/parity-check.mjs
 *   PARITY_MAX_LAG_MIN=15 node scripts/parity-check.mjs --json
 *
 * Environment:
 *   PARITY_BASE_URL      site to measure (default the production host)
 *   EXPECTED_SHA         expected head sha (otherwise git origin/main, then GitHub)
 *   PARITY_MAX_LAG_MIN   acceptable lag in minutes (default 15)
 *   GH_TOKEN/GITHUB_TOKEN  used only for the GitHub API fallback
 *
 * Exit codes: 0 = in sync or within the window; 1 = behind origin/main beyond
 * the window (or behind with an unknown head age); 2 = unmeasurable (served
 * stamp unreachable, or the expected head could not be resolved).
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const DEFAULT_MAX_LAG_MIN = 15;

const BASE = (process.env.PARITY_BASE_URL || process.env.SMOKE_BASE_URL || "https://ns539626.ip-144-217-72.net").replace(/\/$/, "");
const MAX_LAG_MIN = Math.max(0, Number(process.env.PARITY_MAX_LAG_MIN) || DEFAULT_MAX_LAG_MIN);

/** One canonical, greppable verdict. Pure; exported for pins. */
export function classifyParity({ served, expected, lagMinutes, maxLagMinutes = DEFAULT_MAX_LAG_MIN }) {
  if (!served) return { status: "UNMEASURABLE", reason: "served stamp unreachable", ok: false };
  if (!expected) return { status: "UNMEASURABLE", reason: "origin/main head unknown", ok: false };
  if (served === expected) return { status: "IN_SYNC", reason: "served == origin/main", ok: true };
  if (lagMinutes === null || lagMinutes === undefined) {
    return { status: "BEHIND_UNKNOWN_AGE", reason: "served != origin/main and head age is unknown", ok: false };
  }
  if (lagMinutes <= maxLagMinutes) {
    return { status: "BEHIND_WITHIN_WINDOW", reason: `lag ${lagMinutes}min <= ${maxLagMinutes}min window`, ok: true };
  }
  return { status: "BEHIND", reason: `lag ${lagMinutes}min > ${maxLagMinutes}min window`, ok: false };
}

async function fetchText(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000), cache: "no-store" });
  return { status: res.status, body: await res.text() };
}

/** Served artifact identity: /__commit.txt, then /api/health's build field. */
export async function readServed(base = BASE) {
  try {
    const commit = await fetchText(`${base}/__commit.txt`, {});
    const sha = commit.body.trim();
    if (commit.status === 200 && /^[0-9a-f]{40}$/i.test(sha)) return sha.toLowerCase();
  } catch {
    // fall through to health
  }
  try {
    const health = await fetchText(`${base}/api/health`, { accept: "application/json" });
    const parsed = JSON.parse(health.body);
    const build = String(parsed?.build ?? "").trim();
    if (/^[0-9a-f]{7,40}$/i.test(build)) return build.toLowerCase();
  } catch {
    // unmeasurable
  }
  return "";
}

/**
 * Resolve the CURRENT origin/main head: explicit env first, then the GitHub API
 * (fresh, authoritative), then a best-effort `git fetch` + local ref. The
 * local ref alone is not enough: a lane's checkout can be hours stale, and a
 * stale ref would report a false BEHIND (or a false IN_SYNC).
 */
export async function resolveExpected() {
  const explicit = (process.env.EXPECTED_SHA || process.env.PARITY_EXPECTED_SHA || "").trim().toLowerCase();
  if (explicit) return { sha: explicit, source: "EXPECTED_SHA" };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  const repo = process.env.GITHUB_REPOSITORY || "";
  if (token && repo) {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/commits/main`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        const body = await res.json();
        const sha = String(body?.sha ?? "").toLowerCase();
        if (/^[0-9a-f]{40}$/.test(sha)) return { sha, source: "GitHub API" };
      }
    } catch {
      // fall through to git
    }
  }
  try {
    // Refresh the remote-tracking ref so a stale checkout cannot lie. This
    // only updates refs/remotes/origin/main; it never touches the worktree.
    execFileSync("git", ["fetch", "--quiet", "origin", "main"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20_000,
    });
  } catch {
    // offline / no credential helper: use whatever ref is present
  }
  try {
    const sha = execFileSync("git", ["rev-parse", "origin/main"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim()
      .toLowerCase();
    if (/^[0-9a-f]{40}$/.test(sha)) return { sha, source: "git origin/main (fetched)" };
  } catch {
    // no local git / no remote ref
  }
  return { sha: "", source: "unavailable" };
}

/** Head commit age in minutes: local git first, then the GitHub API. */
export async function headAgeMinutes(sha) {
  if (!sha) return null;
  try {
    const ts = Number(
      execFileSync("git", ["log", "-1", "--format=%ct", sha], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(),
    );
    if (Number.isFinite(ts) && ts > 0) return Math.max(0, Math.floor((Date.now() / 1000 - ts) / 60));
  } catch {
    // not in local history
  }
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  const repo = process.env.GITHUB_REPOSITORY || "";
  if (!token || !repo) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const date = Date.parse(body?.commit?.committer?.date ?? "");
    if (!Number.isFinite(date)) return null;
    return Math.max(0, Math.floor((Date.now() - date) / 60_000));
  } catch {
    return null;
  }
}

export async function runParityCheck(opts = {}) {
  const base = opts.base ?? BASE;
  const maxLag = opts.maxLagMinutes ?? MAX_LAG_MIN;
  const served = opts.served ?? (await readServed(base));
  const expectedResolved = opts.expected ? { sha: opts.expected, source: "provided" } : await resolveExpected();
  const expected = expectedResolved.sha;
  const lagMinutes = opts.lagMinutes !== undefined ? opts.lagMinutes : await headAgeMinutes(expected);
  const verdict = classifyParity({ served, expected, lagMinutes, maxLagMinutes: maxLag });
  return { base, served, expected, expectedSource: expectedResolved.source, lagMinutes, maxLagMinutes: maxLag, ...verdict };
}

function canonicalLine(r) {
  return `PARITY: served=${r.served || "unknown"} origin/main=${r.expected || "unknown"} lag_min=${r.lagMinutes ?? "unknown"} threshold_min=${r.maxLagMinutes} status=${r.status} — ${r.reason}`;
}

async function main() {
  const json = process.argv.includes("--json");
  const result = await runParityCheck();
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(canonicalLine(result));
    if (result.status === "BEHIND" || result.status === "BEHIND_UNKNOWN_AGE") {
      console.error(
        `::warning::served head is behind origin/main beyond the ${result.maxLagMinutes}-minute invariant — ` +
          "the stamp-parity tripwire owns the alert; deploy origin/main and re-check.",
      );
    }
  }
  // Exit 2 is reserved for "could not measure"; a real divergence is 1.
  process.exit(result.status === "UNMEASURABLE" ? 2 : result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
