/**
 * REEA-1009 — bet #2 server-side feature flag (spec v1.0 §9: "single change
 * behind a server-side flag; production enable only after Gate 1 + Gate 2").
 *
 * Every S1/S2 behavior change (fail-fast lane constants, the Next Store
 * clearance-stickiness TTL, the weekly metric-honesty note) reads this one
 * switch. Flag OFF — the default, and the state the CI-parity chain runs
 * under — is byte-for-byte the pre-bet serve path, which is exactly the
 * rollback contract (§9: flag-off reverts; no data migration). Production
 * enable is a Vercel environment variable set by DevOps after Gate 1 +
 * Gate 2 pass; nothing in the repo flips it.
 *
 * Pure module on purpose: adapters, the dispatch layer and the metrics
 * routes all read it at call time, and the Gate 2 fixture pins both flag
 * states by stubbing the env var — no import-time capture anywhere.
 */

/** Vercel env var DevOps sets to enable the bet #2 serve path. */
export const BET2_FLAG_ENV = "REEMCO_BET2_FAIL_FAST";

/** Accepted truthy spellings (anything else, including unset, reads OFF). */
export function bet2FailFastEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env[BET2_FLAG_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

/**
 * S1a — challenge-handshake rotation budget. The joined hop ceiling is
 * deadlineMs + STAGE_TAIL_HEADROOM_MS = 1800 + 6200 = 8 s; the rotation must
 * finish INSIDE one window with margin (spec §5 S1a), so a failing handshake
 * lane settles at the budget boundary instead of pinning convergence at the
 * full 8 s ceiling. 6.5 s leaves 1.5 s of margin and still covers the
 * observed healthy handshake floor (~5–6 s end-to-end) — a lane that is
 * going to clear does so within the budget; one that is not stops burning
 * the convergence budget on doomed sub-attempts.
 */
export const BET2_CHALLENGE_ROTATION_BUDGET_MS = 6_500;

/**
 * S1a — minimum window slice a rotation attempt must still have available
 * (after the 250 ms polite pause) before the loop starts it. An attempt
 * given less than this cannot answer meaningfully, so starting it is pure
 * latency burn — exactly the class S1a removes.
 */
export const BET2_ROTATION_ATTEMPT_MARGIN_MS = 400;

/**
 * S2(i) — clearance-stickiness TTL for the Next Store jar mirror. The shared
 * default stays 10 min (CHALLENGE_COOKIE_TTL_MS); `cf_clearance` cookies
 * typically outlive that, and the W37→W38 failure jump (5.1% → 32.2%) is the
 * egress re-paying the handshake on every recycled instance. 30 min lets a
 * recycled instance REPLAY the mirrored clearance instead of re-rolling the
 * per-egress IP-reputation coin-flip. A stale replay degrades exactly as
 * before: the hop 403s, the next handshake re-pays and re-mirrors — bounded,
 * best-effort, never a failed serve.
 */
export const BET2_NEXTSTORE_JAR_TTL_MS = 30 * 60_000;

/** The host whose jar mirror gets the sticky TTL (S2 names it explicitly). */
export const BET2_NEXTSTORE_HOST = "www.nextstore.com.kw";

/**
 * S1a guard, pure so the Gate 2 fixture can pin the boundary: may another
 * rotation attempt START when `elapsedMs` of the rotation budget is already
 * spent? Needs the 250 ms polite pause plus at least the attempt margin of
 * usable window to be worth starting.
 */
export function bet2RotationCanStartAttempt(elapsedMs: number, budgetMs: number): boolean {
  return elapsedMs + 250 + BET2_ROTATION_ATTEMPT_MARGIN_MS <= budgetMs;
}
