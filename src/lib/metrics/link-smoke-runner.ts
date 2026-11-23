/**
 * REEA-1078 — daily dead-link smoke, run by the app itself.
 *
 * Why here: after the self-hosted cutover the link-rot monitor stopped running
 * (W47/W48 `link_smoke.runs` = 0 — REEA-1074 F4). The checker script
 * (scripts/dead-link-smoke.mjs) is the tested unit of work, but the only
 * scheduler on the box that is installed by the deploy path is the existing
 * `reemco-health.timer` (REEA-1044). So the health probe schedules this
 * runner behind its response (`after()`), and a shared-KV day guard makes it
 * run at most once per UTC day — no new host unit, no new cron, and the
 * deploy that ships this file also starts the daily smoke.
 *
 * Data posture is unchanged from the REEA-807/REEA-935 ingest: the runner
 * samples THIS site's own converged live feed (`/api/results-followup`, never
 * a bundled catalog), checks a bounded per-retailer sample politely (per-host
 * identity + pacing), and records aggregate counters only — checked / dead /
 * challenge and retailer names. No URL, no query, no identifier is stored.
 *
 * Best-effort by construction: a failed run never surfaces on the health
 * response, and the day guard is only stamped AFTER a successful record so a
 * transient failure retries on the next probe instead of leaving a silent gap.
 */
import { getSharedKv } from "@/lib/collect/kv";
import { recordLinkSmoke } from "@/lib/metrics";
// The checker's tested core (REEA-935 outcome machine + identity/pacing
// table). Imported rather than duplicated so the CLI and the daily run can
// never drift; the script only executes its own main() when run directly.
import { runDeadLinkSmoke } from "../../../scripts/dead-link-smoke.mjs";

/** Shared-KV day stamp: the UTC day the last successful smoke was recorded. */
export const LINK_SMOKE_DAY_KEY = "link_smoke:last_run_day";

/** Keep the stamp longer than the daily cadence so a missed day still reads. */
const LINK_SMOKE_DAY_TTL_S = 8 * 24 * 60 * 60;

export interface LinkSmokeResult {
  checked: number;
  dead: number;
  challenge: number;
  ok: number;
  byRetailer: Record<string, { checked: number; dead: number; challenge: number }>;
}

/** UTC day string ("2026-11-23") — the once-per-day guard unit. */
export function utcDayOf(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

// Per-instance in-flight guard: two probes landing together must not both run
// the (network-heavy) smoke before either has stamped the day.
let running = false;
// Memory fallback when no shared store is bound (local dev/tests).
let lastRunDay = "";

export interface DailyLinkSmokeDeps {
  /** Origin whose own converged feed is sampled (loopback on the box). */
  origin: string;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable runner (tests) — defaults to the real checker. */
  run?: (opts: { base: string }) => Promise<LinkSmokeResult>;
}

/**
 * Run the daily smoke at most once per UTC day, then record it. Returns
 * whether this call actually ran (false = already done today / in flight /
 * failed). Never throws: instrumentation must not break the health probe.
 */
export async function maybeRunDailyLinkSmoke(deps: DailyLinkSmokeDeps): Promise<boolean> {
  if (running) return false;
  const now = deps.now ?? Date.now;
  const today = utcDayOf(now());
  const kv = getSharedKv();

  let last = lastRunDay;
  if (kv) {
    const stored = await kv.get(LINK_SMOKE_DAY_KEY).catch(() => null);
    if (stored) last = stored.trim();
  }
  if (last === today) return false;

  running = true;
  try {
    const run =
      deps.run ??
      ((opts: { base: string }) =>
        runDeadLinkSmoke(opts) as unknown as Promise<LinkSmokeResult>);
    const result = await run({ base: deps.origin });
    await recordLinkSmoke(result);
    lastRunDay = today;
    if (kv) {
      await kv.set(LINK_SMOKE_DAY_KEY, today, LINK_SMOKE_DAY_TTL_S).catch(() => false);
    }
    console.log(
      `link smoke ${today}: ${result.checked} checked / ${result.dead} dead / ${result.challenge} challenge`,
    );
    return true;
  } catch (e) {
    // No stamp: the next probe retries, so a transient failure cannot leave a
    // silent measurement gap (a week with 0 runs is the defect, REEA-1078 AC-2).
    console.error("link smoke run failed", e);
    return false;
  } finally {
    running = false;
  }
}
