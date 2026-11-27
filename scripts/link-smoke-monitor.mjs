/**
 * REEA-1252 — the link-rot guardrail's alert path.
 *
 * Why this exists: `/api/metrics/weekly` carried `link_smoke` counters that
 * nobody graded. A week could collapse from 320 checked links to 16 (or 0 runs)
 * and no job failed. This monitor reads the weekly snapshot, grades every week
 * in the window against the stated floor and rates, and exits non-zero so
 * `.github/workflows/link-smoke-monitor.yml` opens a `link-smoke-alert` ticket
 * (the same deduped-issue path as the uptime probe).
 *
 * STATED RULE (the "why 320" the ticket asks for):
 *   - 320 checked links/week is the pre-v5 design ceiling — 20 retailers x
 *     8 links x 2 queries — restored here as the floor. The daily run samples
 *     up to 96 links across up to 8 retailers (scripts/dead-link-smoke.mjs),
 *     so 7 days can deliver up to 672; ceil(320/7) = 46 checked/day is the
 *     prorated floor used for the in-progress week.
 *   - runs >= 7/week (>= 1/day): a spot check is not a guardrail.
 *   - dead_rate > 10% fails. The post-REEA-922 baseline was ~5.6% dead; a
 *     sustained 10% is real rot, not checker noise.
 *   - challenge_rate > 25% fails. Challenges stay in the checked denominator
 *     (challenge_rate = challenge/checked) and are surfaced, never dropped.
 *   - Weeks before `sinceWeek` (the week this guardrail was restored) are
 *     skipped so the pre-fix empty week (W47: runs=0) does not alert forever.
 *   - The in-progress week is graded against the prorated floor, so the monitor
 *     cannot stay silent mid-week while the sample is collapsing.
 *
 * Usage:
 *   node scripts/link-smoke-monitor.mjs --base https://ns539626.ip-144-217-72.net
 *   node scripts/link-smoke-monitor.mjs --json /tmp/weekly.json   # offline test
 *   node scripts/link-smoke-monitor.mjs --simulate-failure        # prove the alert path
 *
 * Exit 0 = all graded weeks pass; exit 1 = at least one failure (the workflow
 * opens/appends the ticket); exit 2 = the read itself failed (503 / bad JSON),
 * which the workflow also treats as an alert.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Thresholds are code, versioned with the monitor, not a silent config knob. */
export const THRESHOLDS = Object.freeze({
  weeklyCheckedFloor: 320,
  dailyCheckedFloor: Math.ceil(320 / 7), // 46
  weeklyRunsFloor: 7,
  deadRateMax: 0.1,
  challengeRateMax: 0.25,
  // The week the guardrail was restored (REEA-1252). Earlier weeks are history.
  sinceWeek: "2026-W48",
});

const DEFAULT_BASE = "https://ns539626.ip-144-217-72.net";
const FETCH_TIMEOUT_MS = 30_000;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** ISO week key ("2026-W48") for a Date — the key shape the metrics route uses. */
export function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

/** Elapsed days of the current UTC week, 1 (Monday) .. 7 (Sunday). */
export function elapsedDaysOfWeek(now) {
  const d = new Date(now);
  const day = d.getUTCDay() || 7;
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (day - 1));
  return Math.floor((now - monday) / 86_400_000) + 1;
}

/**
 * Pure grader. Returns { ok, failures, rows, thresholds, currentWeek,
 * elapsedDays }. `opts.thresholds` overrides THRESHOLDS for tests; `opts.now`
 * is the clock. No network.
 */
export function evaluateLinkSmoke(payload, opts = {}) {
  const t = { ...THRESHOLDS, ...(opts.thresholds ?? {}) };
  const now = opts.now ?? Date.now();
  const weeks = payload?.weeks && typeof payload.weeks === "object" ? payload.weeks : {};
  const currentWeek = isoWeekKey(new Date(now));
  const elapsedDays = elapsedDaysOfWeek(now);
  const failures = [];
  const rows = [];

  for (const [week, data] of Object.entries(weeks).sort(([a], [b]) => a.localeCompare(b))) {
    if (week < t.sinceWeek) continue; // pre-guardrail history is not graded
    const ls = data?.link_smoke ?? {};
    const checked = num(ls.checked);
    const runs = num(ls.runs);
    const dead = num(ls.dead);
    const challenge = num(ls.challenge);
    const ok = num(ls.ok);
    const deadDenominator = ok + dead;
    const deadRate =
      typeof ls.dead_rate === "number" && Number.isFinite(ls.dead_rate)
        ? ls.dead_rate
        : deadDenominator > 0
          ? dead / deadDenominator
          : 0;
    const challengeRate =
      typeof ls.challenge_rate === "number" && Number.isFinite(ls.challenge_rate)
        ? ls.challenge_rate
        : checked > 0
          ? challenge / checked
          : 0;
    const complete = week < currentWeek;
    // A complete week must hit the full floor; the in-progress week is graded
    // against the prorated floor so mid-week silence is still a failure.
    const checkedFloor = complete ? t.weeklyCheckedFloor : t.dailyCheckedFloor * elapsedDays;
    const runsFloor = complete ? t.weeklyRunsFloor : elapsedDays;

    const row = {
      week,
      complete,
      checked,
      runs,
      dead,
      challenge,
      ok,
      dead_rate: Number(deadRate.toFixed(4)),
      challenge_rate: Number(challengeRate.toFixed(4)),
      checked_floor: checkedFloor,
      runs_floor: runsFloor,
    };
    rows.push(row);

    if (checked < checkedFloor) {
      failures.push({ week, rule: "checked_floor", detail: `checked ${checked} < ${checkedFloor}` });
    }
    if (runs < runsFloor) {
      failures.push({ week, rule: "runs_floor", detail: `runs ${runs} < ${runsFloor}` });
    }
    if (deadRate > t.deadRateMax) {
      failures.push({
        week,
        rule: "dead_rate",
        detail: `dead_rate ${(deadRate * 100).toFixed(1)}% > ${(t.deadRateMax * 100).toFixed(0)}%`,
      });
    }
    if (challengeRate > t.challengeRateMax) {
      failures.push({
        week,
        rule: "challenge_rate",
        detail: `challenge_rate ${(challengeRate * 100).toFixed(1)}% > ${(t.challengeRateMax * 100).toFixed(0)}%`,
      });
    }
  }

  if (rows.length === 0) {
    failures.push({
      week: currentWeek,
      rule: "no_data",
      detail: `no graded week at/after ${t.sinceWeek} in the weekly payload`,
    });
  }

  return { ok: failures.length === 0, failures, rows, thresholds: t, currentWeek, elapsedDays };
}

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const base = (argValue(args, "--base") ?? process.env.PROD_BASE_URL ?? DEFAULT_BASE).replace(/\/$/, "");
  const simulateFailure = args.includes("--simulate-failure");
  const jsonPath = argValue(args, "--json");

  let payload;
  if (jsonPath) {
    payload = JSON.parse(readFileSync(jsonPath, "utf8"));
  } else {
    const url = `${base}/api/metrics/weekly?weeks=4`;
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        console.error(`LINK_SMOKE_MONITOR READ_FAILED — ${res.status} from ${url}`);
        process.exit(2);
      }
      payload = await res.json();
    } catch (e) {
      console.error(`LINK_SMOKE_MONITOR READ_FAILED — ${e?.message ?? e} (${url})`);
      process.exit(2);
    }
  }

  const result = evaluateLinkSmoke(payload);
  if (simulateFailure) {
    result.ok = false;
    result.failures.push({
      week: result.currentWeek,
      rule: "simulated_failure",
      detail: "forced by --simulate-failure (alert-path proof)",
    });
  }

  for (const r of result.rows) {
    console.log(
      `week ${r.week}${r.complete ? "" : " (in progress)"}: checked=${r.checked}/${r.checked_floor} runs=${r.runs}/${r.runs_floor} dead=${r.dead} challenge=${r.challenge} dead_rate=${(r.dead_rate * 100).toFixed(1)}% challenge_rate=${(r.challenge_rate * 100).toFixed(1)}%`,
    );
  }
  for (const f of result.failures) {
    console.error(`FAIL ${f.week} ${f.rule}: ${f.detail}`);
  }
  console.log(
    `LINK_SMOKE_MONITOR ${result.ok ? "PASS" : "FAIL"} — current=${result.currentWeek} elapsed_days=${result.elapsedDays} floor=${result.thresholds.weeklyCheckedFloor}/week (${result.thresholds.dailyCheckedFloor}/day) dead_rate_max=${(result.thresholds.deadRateMax * 100).toFixed(0)}% challenge_rate_max=${(result.thresholds.challengeRateMax * 100).toFixed(0)}%`,
  );
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
