/**
 * REEA-1078 S2 — dead-lane retirement, canary re-admission and the
 * 7-day auto-retire rule.
 *
 * Why: Next Store recorded 1,338/1,338 failures in W47 and 365/365 in W48 —
 * 100% failure across 1,703 attempts — while still sitting in the default
 * fan-out on every search. A lane that has never answered costs a hop window
 * on every serve (latency, AC-8) and, worse, its note reads like a coverage
 * statement. This module is the one place that decides which lanes the
 * default fan-out may contact:
 *
 *  - `DEFAULT_RETIRED_LANES` is the code-level retirement (recorded in git,
 *    the same posture as the PC Kuwait / Ounass retirements): those lanes are
 *    never dispatched, so `retailer_adapter_attempts["Next Store"]` stops
 *    growing immediately.
 *  - The dynamic rule adds any lane that has failed EVERY attempt since at
 *    least 7 days ago (`laneShouldRetire`). It reuses the same attempts /
 *    failures signal the weekly counters already carry — no new per-retailer
 *    latency series (Data Minimization).
 *  - Re-admission is explicit and gated on a canary: the daily lane-health
 *    run probes a retired lane once (the real adapter, one bounded hop) and
 *    only `LANE_CANARY_SUCCESS_STREAK` consecutive canary successes return it
 *    to the default fan-out (`applyCanaryOutcome`).
 *
 * Storage posture: aggregate integers and retailer names only. The per-lane
 * daily records are {day, attempts, failures}; nothing per-query or per-user
 * is written. Every store call is best-effort — a KV hiccup degrades to
 * "nothing extra is retired", never to a failed serve (graceful degradation).
 */
import { getSharedKv } from "@/lib/collect/kv";

/**
 * Lanes retired from the DEFAULT fan-out at the code level, with the evidence
 * that retired them. They stay declared in COLLECTORS (the adapter and its
 * parser stay tested) and are filtered out at dispatch.
 *
 * REEA-1221 (2026-11-26) — this list is now EMPTY, and that is the point of
 * the CEO directive on REEA-1216 ("it needs to be fixed. not killed."): no lane
 * is skipped at the code level any more. The one static retirement that stood
 * here was Next Store (Magento SSR behind a Cloudflare managed challenge,
 * 1,338/1,338 failures in W47 and 365/365 in W48 — REEA-1074 F4). It was
 * re-admitted because its collector now ends on the real-browser clearance
 * tier, which clears the challenge and paints the Magento grid (12 priced
 * cards on `laptop`, measured 2026-11-26).
 *
 * REEA-1207 (Bet 7B) — the six zero-offer lanes (Lulu Hypermarket, BinSina,
 * Yousifi, YasO, Hobby Center, Bomai: 19,447 attempts each, 0 offers in W48)
 * were already not retired. A lane still leaves the fan-out only when the
 * 7-day every-attempt-failed rule or the canary says so.
 */
export const DEFAULT_RETIRED_LANES: readonly string[] = [
  // REEA-1221 — PM ruling on REEA-1225 (2026-11-26). These three lanes left the
  // fan-out on "no addressable catalogue", NOT because they failed: their
  // adapters, parsers and tests stay, and the canary re-admits a lane the day
  // its storefront answers with a priced card.
  //   Bomai        — bomai.com has been a Chinese domain-parking shell;
  //                  /search?q= answers 404; bomai.com.kw is NXDOMAIN.
  //   Hobby Center — hobbycenter.com.kw is NXDOMAIN; the real domain
  //                  hobbycenter.net is the retailer's "Launching Soon"
  //                  placeholder (origin re-pointed there).
  //   YasO         — yaso.com is a Korean site (406 over https, 403 over http,
  //                  self-signed cert, +82 phone); the retailer is
  //                  Instagram-only today.
  "Bomai",
  "Hobby Center",
  "YasO",
];

/**
 * REEA-1221 — the reason string a code-level retirement carries. It is policy,
 * not evidence, so a persisted record with this reason must not outlive the
 * policy: when a lane leaves DEFAULT_RETIRED_LANES the stale record is ignored
 * and the lane is dispatched again (Next Store, re-admitted 2026-11-26).
 */
export const STATIC_RETIREMENT_REASON = "static retirement (no answer from this egress)";

/** A lane must have failed every attempt for at least this many days. */
export const LANE_RETIRE_WINDOW_DAYS = 7;

/** Consecutive canary successes that return a retired lane to the fan-out. */
export const LANE_CANARY_SUCCESS_STREAK = 3;

/** Shared-KV key holding the lane-health state blob (aggregate counters only). */
export const LANE_HEALTH_KEY = "lane_health:v1";

/** Shared-KV day stamp: the UTC day the last successful lane-health run ran. */
export const LANE_HEALTH_DAY_KEY = "lane_health:last_run_day";

/** Keep the state longer than the daily cadence so a missed day still reads. */
export const LANE_HEALTH_TTL_S = 8 * 24 * 60 * 60;

/** UTC days of per-lane attempt/failure evidence retained (window + 1). */
export const LANE_DAY_RETENTION_DAYS = LANE_RETIRE_WINDOW_DAYS + 1;

/**
 * The query a canary asks. It matches the `/api/echo` Next Store probe
 * (`iphone 17`) so the canary and the tripwire agree on what "answers" means,
 * and it is a head query every Kuwait retailer stocks.
 */
export const LANE_CANARY_QUERY = "iphone 17";

/** In-process memo lifetime for the retired-lane read on the serve path. */
const RETIRED_LANES_MEMO_MS = 60_000;

export interface LaneDayRecord {
  /** UTC day, "YYYY-MM-DD". */
  day: string;
  attempts: number;
  failures: number;
}

export interface LaneHealth {
  /** Per-day aggregate attempts/failures (bounded retention, see prune). */
  days: LaneDayRecord[];
  /**
   * ISO timestamp when the CURRENT all-failure streak started — the first
   * attempt of a run of serves where every attempt failed. Cleared by any
   * successful attempt. This is what makes "100% failure for 7 days"
   * measurable without inventing a new series.
   */
  failingSince?: string;
  /** Consecutive canary successes observed since the lane was retired. */
  canaryStreak: number;
  /** Set when the lane is out of the default fan-out. */
  retiredAt?: string;
  /** Short, internals-free reason ("no successful answer for 7 days"). */
  retiredReason?: string;
  /** Set when a canary streak returned the lane to the fan-out. */
  readmittedAt?: string;
  /** ISO timestamp of the last canary probe. */
  lastCanaryAt?: string;
  /** ISO timestamp of the last successful attempt. */
  lastSuccessAt?: string;
}

export interface LaneHealthState {
  version: 1;
  lanes: Record<string, LaneHealth>;
}

export interface LaneHealthRead {
  state: LaneHealthState;
  /** false = the shared store could not be read; the caller must fail open. */
  reachable: boolean;
}

export function emptyLaneHealth(): LaneHealth {
  return { days: [], canaryStreak: 0 };
}

export function emptyLaneHealthState(): LaneHealthState {
  return { version: 1, lanes: {} };
}

/** UTC day string ("2026-11-23") — the per-lane evidence bucket unit. */
export function utcDayOf(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function clampCount(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), 1_000_000_000);
}

/** Same string hygiene as the metrics store: bounded, control chars stripped. */
function cleanName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120);
}

function cleanIso(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/** Normalize a stored blob defensively (a hand-edited or legacy value must
 *  never break the serve path). Unknown lanes/fields are dropped, counters
 *  clamped. */
export function normalizeLaneHealthState(raw: unknown): LaneHealthState {
  const state = emptyLaneHealthState();
  if (!raw || typeof raw !== "object") return state;
  const lanes = (raw as { lanes?: unknown }).lanes;
  if (!lanes || typeof lanes !== "object") return state;
  for (const [merchantRaw, laneRaw] of Object.entries(lanes as Record<string, unknown>)) {
    const merchant = cleanName(merchantRaw);
    if (!merchant || !laneRaw || typeof laneRaw !== "object") continue;
    const l = laneRaw as Record<string, unknown>;
    const lane = emptyLaneHealth();
    if (Array.isArray(l.days)) {
      for (const d of l.days) {
        if (!d || typeof d !== "object") continue;
        const day = cleanName((d as LaneDayRecord).day);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        const attempts = clampCount((d as LaneDayRecord).attempts);
        lane.days.push({
          day,
          attempts,
          // Same invariant the serve fold enforces: failures can never exceed
          // attempts, so a hand-edited value cannot invert a week's reading.
          failures: Math.min(clampCount((d as LaneDayRecord).failures), attempts),
        });
      }
    }
    lane.failingSince = cleanIso(l.failingSince);
    lane.canaryStreak = clampCount(l.canaryStreak);
    lane.retiredAt = cleanIso(l.retiredAt);
    lane.retiredReason = typeof l.retiredReason === "string" ? l.retiredReason.slice(0, 160) : undefined;
    lane.readmittedAt = cleanIso(l.readmittedAt);
    lane.lastCanaryAt = cleanIso(l.lastCanaryAt);
    lane.lastSuccessAt = cleanIso(l.lastSuccessAt);
    state.lanes[merchant] = lane;
  }
  return state;
}

/** Drop day buckets older than the retention window (bounded storage). */
export function pruneLaneDays(state: LaneHealthState, now = Date.now()): LaneHealthState {
  const cutoff = utcDayOf(now - (LANE_DAY_RETENTION_DAYS - 1) * 86_400_000);
  for (const lane of Object.values(state.lanes)) {
    lane.days = lane.days.filter((d) => d.day >= cutoff);
  }
  return state;
}

/**
 * Fold one serve's per-lane attempts/failures into the daily evidence.
 *
 * A serve that answered for a lane clears its failure streak (one success is
 * enough to disprove "100% failure"); a serve where every attempt failed
 * starts/extends it. Pure: takes and returns state, never mutates the input.
 */
export function applyLaneAttempts(
  state: LaneHealthState,
  telemetry: { attempts?: Record<string, number>; failures?: Record<string, number> },
  now = Date.now(),
): LaneHealthState {
  const next: LaneHealthState = {
    version: 1,
    lanes: Object.fromEntries(
      Object.entries(state.lanes).map(([m, l]) => [
        m,
        { ...l, days: l.days.map((d) => ({ ...d })) },
      ]),
    ),
  };
  const day = utcDayOf(now);
  const iso = new Date(now).toISOString();
  for (const [merchantRaw, attemptsRaw] of Object.entries(telemetry.attempts ?? {})) {
    const merchant = cleanName(merchantRaw);
    if (!merchant) continue;
    const attempts = clampCount(attemptsRaw);
    if (attempts === 0) continue;
    const failures = Math.min(clampCount(telemetry.failures?.[merchantRaw]), attempts);
    const lane = (next.lanes[merchant] ??= emptyLaneHealth());
    const bucket = lane.days.find((d) => d.day === day);
    if (bucket) {
      bucket.attempts += attempts;
      bucket.failures += failures;
    } else {
      lane.days.push({ day, attempts, failures });
    }
    if (failures >= attempts) {
      // Every attempt failed: start or extend the streak.
      lane.failingSince ??= iso;
    } else {
      // At least one attempt answered: the streak is disproven.
      lane.failingSince = undefined;
      lane.lastSuccessAt = iso;
    }
  }
  return pruneLaneDays(next, now);
}

/**
 * AC-7 — 100% failure for 7 days. True only when the lane's current
 * all-failure streak is at least `LANE_RETIRE_WINDOW_DAYS` old AND it has
 * evidence in that window (a lane never attempted is not "failing").
 */
export function laneShouldRetire(lane: LaneHealth | undefined, now = Date.now()): boolean {
  if (!lane?.failingSince) return false;
  const since = Date.parse(lane.failingSince);
  if (!Number.isFinite(since)) return false;
  if (now - since < LANE_RETIRE_WINDOW_DAYS * 86_400_000) return false;
  const cutoff = utcDayOf(now - LANE_RETIRE_WINDOW_DAYS * 86_400_000);
  return lane.days.some((d) => d.day >= cutoff && d.attempts > 0);
}

/** Mark a lane out of the default fan-out (idempotent; keeps the evidence). */
export function retireLane(
  state: LaneHealthState,
  merchant: string,
  now = Date.now(),
  reason = "no successful answer for 7 days",
): LaneHealthState {
  const lane = (state.lanes[merchant] ??= emptyLaneHealth());
  lane.retiredAt ??= new Date(now).toISOString();
  lane.retiredReason ??= reason.slice(0, 160);
  return state;
}

/**
 * AC-7 — canary re-admission. A success extends the consecutive-success
 * streak; a failure resets it (the lane must answer N times in a row, not N
 * times ever). At `LANE_CANARY_SUCCESS_STREAK` the lane returns to the
 * default fan-out. Returns the mutated state plus whether it was readmitted.
 */
export function applyCanaryOutcome(
  state: LaneHealthState,
  merchant: string,
  ok: boolean,
  now = Date.now(),
): { state: LaneHealthState; readmitted: boolean } {
  const lane = (state.lanes[merchant] ??= emptyLaneHealth());
  lane.lastCanaryAt = new Date(now).toISOString();
  if (!ok) {
    lane.canaryStreak = 0;
    return { state, readmitted: false };
  }
  lane.canaryStreak += 1;
  // REEA-1207 — a STATICALLY retired lane is retired in the same persisted
  // shape (the daily runner seeds `retiredAt` for DEFAULT_RETIRED_LANES), so
  // the streak clears it here exactly like a dynamically retired lane. Without
  // this a canary could never return a code-level retired lane to the fan-out.
  if (lane.canaryStreak >= LANE_CANARY_SUCCESS_STREAK && lane.retiredAt) {
    lane.retiredAt = undefined;
    lane.retiredReason = undefined;
    lane.canaryStreak = 0;
    lane.failingSince = undefined;
    lane.lastSuccessAt = lane.lastCanaryAt;
    lane.readmittedAt = lane.lastCanaryAt;
    return { state, readmitted: true };
  }
  return { state, readmitted: false };
}

/** Lanes the persisted state says are out of the default fan-out. */
export function retiredLanesOf(state: LaneHealthState): string[] {
  return Object.entries(state.lanes)
    .filter(([m, l]) => {
      if (!l.retiredAt) return false;
      // REEA-1221 — a record that only reflects the old code-level policy is
      // not evidence: once the lane is no longer in DEFAULT_RETIRED_LANES the
      // stored static retirement stops vetoing the dispatch.
      const staleStatic =
        (l.retiredReason ?? "").startsWith(STATIC_RETIREMENT_REASON) &&
        !DEFAULT_RETIRED_LANES.includes(m);
      return !staleStatic;
    })
    .map(([m]) => m)
    .sort();
}

/**
 * REEA-1207 — lanes a canary has returned to the fan-out. The dispatch layer
 * subtracts these from DEFAULT_RETIRED_LANES so a code-level retirement is not
 * a permanent veto: re-admission happens only through
 * `LANE_CANARY_SUCCESS_STREAK` consecutive real answers, and the 7-day rule can
 * retire the lane again afterwards.
 */
export function readmittedLanesOf(state: LaneHealthState): string[] {
  return Object.entries(state.lanes)
    .filter(([, l]) => Boolean(l.readmittedAt) && !l.retiredAt)
    .map(([m]) => m)
    .sort();
}

/**
 * Read the persisted state. A failed/unparseable read reports `reachable:
 * false` so the caller fails open (retire nothing extra) instead of treating
 * a store blip as "everything recovered".
 */
export async function readLaneHealth(opts: { kv?: ReturnType<typeof getSharedKv> } = {}): Promise<LaneHealthRead> {
  const kv = opts.kv === undefined ? getSharedKv() : opts.kv;
  if (!kv) return { state: emptyLaneHealthState(), reachable: false };
  const raw = await kv.get(LANE_HEALTH_KEY).catch(() => null);
  if (raw === null) {
    // A bound store with no key is an honest empty state, not a failure.
    return { state: emptyLaneHealthState(), reachable: true };
  }
  try {
    return { state: normalizeLaneHealthState(JSON.parse(raw)), reachable: true };
  } catch {
    return { state: emptyLaneHealthState(), reachable: false };
  }
}

export async function writeLaneHealth(
  state: LaneHealthState,
  opts: { kv?: ReturnType<typeof getSharedKv> } = {},
): Promise<boolean> {
  const kv = opts.kv === undefined ? getSharedKv() : opts.kv;
  if (!kv) return false;
  return kv
    .set(LANE_HEALTH_KEY, JSON.stringify(state), LANE_HEALTH_TTL_S)
    .catch(() => false);
}

/**
 * Serve-path read: the dynamically retired lanes, memoized briefly per
 * instance. Fail-open on any store problem (no extra lane is retired). The
 * static `DEFAULT_RETIRED_LANES` are applied separately by the dispatch layer,
 * so even a cold store still keeps Next Store out.
 */
let memo: { at: number; lanes: string[]; readmitted: string[] } | null = null;

export interface LaneRetirementRead {
  /** Lanes the persisted state says are out of the default fan-out right now. */
  retired: string[];
  /** Lanes a canary returned to the fan-out (static retirement must not veto). */
  readmitted: string[];
}

/**
 * REEA-1207 — one read for both halves of the retirement decision. The serve
 * path needs `retired` (do not dispatch) and `readmitted` (a code-level
 * DEFAULT_RETIRED_LANES entry is not permanent), and they must come from the
 * same snapshot so a canary that just re-admitted a lane is never applied to a
 * stale retired list. Fail-open: a store problem yields the memoized view
 * (or nothing extra retired) rather than retiring everything.
 */
export async function readLaneRetirement(opts: {
  now?: number;
  kv?: ReturnType<typeof getSharedKv>;
} = {}): Promise<LaneRetirementRead> {
  const now = opts.now ?? Date.now();
  if (memo && now - memo.at < RETIRED_LANES_MEMO_MS) {
    return { retired: memo.lanes, readmitted: memo.readmitted };
  }
  const read = await readLaneHealth({ kv: opts.kv });
  // Fail open AND memoize the failure: a store blip must not re-pay the KV
  // timeout on every serve for the next minute (AC-8 latency budget).
  const retired = read.reachable ? retiredLanesOf(read.state) : (memo?.lanes ?? []);
  const readmitted = read.reachable ? readmittedLanesOf(read.state) : (memo?.readmitted ?? []);
  memo = { at: now, lanes: retired, readmitted };
  return { retired, readmitted };
}

export async function readRetiredLanes(opts: {
  now?: number;
  kv?: ReturnType<typeof getSharedKv>;
} = {}): Promise<string[]> {
  return (await readLaneRetirement(opts)).retired;
}

/** Test hook: drop the serve-path memo. */
export function resetRetiredLanesMemo(): void {
  memo = null;
}

/**
 * Fold one serve's adapter telemetry into the daily lane evidence. Called from
 * the same deferred after() tail as the weekly outcome counters — behind the
 * response, so it can never delay a render. Best-effort: a store failure
 * leaves the next serve to try again.
 */
export async function recordLaneAttempts(
  telemetry: { attempts?: Record<string, number>; failures?: Record<string, number> },
  opts: { now?: number; kv?: ReturnType<typeof getSharedKv> } = {},
): Promise<void> {
  const merchants = Object.keys(telemetry.attempts ?? {});
  if (merchants.length === 0) return;
  const kv = opts.kv === undefined ? getSharedKv() : opts.kv;
  if (!kv) return;
  const read = await readLaneHealth({ kv });
  if (!read.reachable) return;
  const now = opts.now ?? Date.now();
  const next = applyLaneAttempts(read.state, telemetry, now);
  const ok = await writeLaneHealth(next, { kv });
  if (ok) memo = null;
}

/** Result of one daily lane-health pass (logged only; no PII). */
export interface LaneHealthRunSummary {
  retiredNow: string[];
  readmitted: string[];
  canaried: string[];
  checkedAt: string;
}

export interface LaneCanaryTarget {
  merchant: string;
  /** Runs the real adapter once, bounded; resolves true only on a real answer. */
  canary: (merchant: string) => Promise<boolean>;
}

export interface DailyLaneHealthDeps {
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable store (tests). */
  kv?: ReturnType<typeof getSharedKv>;
  /**
   * Every lane the dispatch layer declares (COLLECTORS). The runner derives
   * the ACTIVE set itself: a lane is active unless the persisted state says it
   * is retired right now — so a lane readmitted by a canary is evaluated by
   * the 7-day rule again, and a lane retired by that rule leaves the fan-out
   * immediately.
   */
  allLanes: readonly string[];
  /** Every lane a canary may probe (retired ones included). */
  canaryTargets: readonly LaneCanaryTarget[];
  /** Injectable day guard (tests). */
  alreadyRanToday?: boolean;
}

let laneHealthRunning = false;
let lastLaneHealthDay = "";

/**
 * AC-7 — the daily lane-health pass, scheduled behind the existing health
 * timer (no new host unit). It (a) evaluates the 7-day rule over the
 * persisted evidence and retires qualifying lanes, then (b) probes every
 * retired lane once through its real adapter and re-admits it on
 * `LANE_CANARY_SUCCESS_STREAK` consecutive answers. The day guard is stamped
 * only after a successful write, so a transient store failure retries on the
 * next tick instead of leaving a silent gap.
 */
export async function maybeRunDailyLaneHealth(
  deps: DailyLaneHealthDeps,
): Promise<LaneHealthRunSummary | null> {
  if (laneHealthRunning) return null;
  const now = deps.now ?? Date.now;
  const today = utcDayOf(now());
  const kv = deps.kv === undefined ? getSharedKv() : deps.kv;
  let last = lastLaneHealthDay;
  if (kv) {
    const stored = await kv.get(LANE_HEALTH_DAY_KEY).catch(() => null);
    if (stored) last = stored.trim();
  }
  if (deps.alreadyRanToday || last === today) return null;

  laneHealthRunning = true;
  try {
    const read = await readLaneHealth({ kv });
    if (!read.reachable && kv) return null;
    const state = read.state;
    // Static retirement is the STARTING state, not a permanent veto: a lane
    // that a canary returned to the fan-out must stay there until the 7-day
    // rule retires it again. "readmittedAt" is the marker for that.
    for (const merchant of DEFAULT_RETIRED_LANES) {
      state.lanes[merchant] ??= emptyLaneHealth();
      if (!state.lanes[merchant].retiredAt && !state.lanes[merchant].readmittedAt) {
        retireLane(state, merchant, now(), STATIC_RETIREMENT_REASON);
      }
    }
    // (a) 7-day auto-retire over lanes still in the fan-out.
    const retiredNow: string[] = [];
    const currentlyRetired = new Set(retiredLanesOf(state));
    for (const merchant of deps.allLanes) {
      if (currentlyRetired.has(merchant)) continue;
      if (laneShouldRetire(state.lanes[merchant], now())) {
        retireLane(state, merchant, now(), "no successful answer for 7 days");
        currentlyRetired.add(merchant);
        retiredNow.push(merchant);
      }
    }
    // (b) canary every lane that is out of the fan-out right now.
    const canaried: string[] = [];
    const readmitted: string[] = [];
    const targets = new Map(deps.canaryTargets.map((t) => [t.merchant, t] as const));
    for (const merchant of [...currentlyRetired].sort()) {
      const target = targets.get(merchant);
      if (!target) continue;
      state.lanes[merchant] ??= emptyLaneHealth();
      let ok = false;
      try {
        ok = await target.canary(merchant);
      } catch {
        ok = false;
      }
      canaried.push(merchant);
      const outcome = applyCanaryOutcome(state, merchant, ok, now());
      if (outcome.readmitted) readmitted.push(merchant);
    }
    pruneLaneDays(state, now());
    const written = await writeLaneHealth(state, { kv });
    if (!written && kv) return null;
    lastLaneHealthDay = today;
    if (kv) {
      await kv.set(LANE_HEALTH_DAY_KEY, today, LANE_HEALTH_TTL_S).catch(() => false);
    }
    memo = null;
    const summary: LaneHealthRunSummary = {
      retiredNow,
      readmitted,
      canaried,
      checkedAt: new Date(now()).toISOString(),
    };
    console.log(
      `lane health ${today}: retired=${JSON.stringify(retiredNow)} canaried=${JSON.stringify(canaried)} readmitted=${JSON.stringify(readmitted)}`,
    );
    return summary;
  } catch (e) {
    // No stamp: the next probe retries.
    console.error("lane health run failed", e);
    return null;
  } finally {
    laneHealthRunning = false;
  }
}

/** Test hook: drop the daily-run memory guard. */
export function resetLaneHealthRunState(): void {
  laneHealthRunning = false;
  lastLaneHealthDay = "";
  memo = null;
}
