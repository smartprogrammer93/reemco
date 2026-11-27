/**
 * REEA-314 — scheduled smoke endpoint for Vercel Cron.
 *
 * Vercel Cron (`crons` in vercel.json, hourly at :17) GETs this route. It runs
 * the same funnel assertions as scripts/smoke-check.mjs steps 1-4 but with
 * plain server-side fetches against the app's own rendered pages, so it fits
 * the cron's short response budget (no headless browser here — that stays in
 * scripts/smoke-check.mjs for Actions/dispatch runs).
 *
 * Deterministic by design: the fixture query matches the seeded catalog the
 * smoke script uses too ("sony"), so a pass means the real shopper funnel —
 * live offers included — renders on the deployed artifact.
 *
 * Assertions mirror the smoke script: step 1 home renders the app shell;
 * step 2 the fixture query yields at least one real result card with a
 * freshness chip; step 3 a card's product page resolves. Failure => HTTP 503
 * naming the failed step, visible in Vercel cron/deployment logs. Skeletons
 * render class skeleton-card (never result-card), so any result-card match is
 * a real card.
 *
 * REEA-377: the served body is the minimal shape — `{ok, build}` (verdict +
 * build stamp) — while the per-step internals (card/chip counts, fixture
 * name, checkedAt/failedAt) go to the function console instead, so a public
 * GET leaks nothing beyond the verdict. GET shares the REEA-37 limiter
 * (REEA-826: per serverless instance — memory-only buckets; REEA-827: the
 * fixed-window counter rides the shared KV when bound, making the budget
 * deployment-wide): while inside
 * the limit the funnel runs and its verdict is
 * cached in memory; past the limit the cached verdict is replayed without a
 * re-walk, so hammering one anonymous endpoint cannot re-run the whole site
 * walk on every hit. Step 3 stays a hard assertion; its hop budget (25 s,
 * REEA-391 tier) covers the measured cold walk so a healthy funnel flips the
 * scheduled tick green rather than sitting at 503.
 *
 * REEA-398 follow-up: the home and results hops read the streamed documents
 * shell-first — the hop resolves on the FIRST flush carrying the assertion
 * inputs (shell marker; card + freshness chip + click-out href) and cancels
 * the rest of the body, so the tick answers in ~1-2 s warm instead of paying
 * the ~21 s staged-collection finalize. The served body keeps the minimal
 * `{ok, build}` shape either way.
 *
 * REEA-1266 — the verdict is stable under concurrent page load. A results
 * render that the collection admission cap defers (REEA-1133 pending shell)
 * — or one whose completion budget closed while hops were still in flight —
 * serves a PROVISIONAL document, not a zero-result answer. That document
 * carries the `data-collection-pending` marker
 * (lib/collect/shell-markers.ts), so this probe treats it as "still working"
 * instead of answering 503 (cards=0): the app is alive and busy serving
 * shoppers, and the follow-up feed folds the real answer in behind the
 * response. When a full walk PROVED the funnel recently, the verdict is
 * replayed from that proof inside REEMCO_HEALTH_VERDICT_REPLAY_MS (default
 * 5 min) — the same "replay a recent good verdict" idea the REEA-37 limiter
 * already applies, scoped to the capacity-deferral case only. "Still working"
 * is bounded: a provisional streak longer than that same window (no proven
 * walk at all in it) is a real 503, so a funnel that never proves itself
 * again cannot read green forever. A SETTLED shell that renders zero cards
 * (or cards without a freshness chip) is a hard 503 too: only evidence of a
 * broken funnel fails the probe.
 */
import { after, type NextRequest } from "next/server";
import { checkRateLimitShared } from "@/lib/rate-limit-kv";
import { invalidateTrendingChips } from "@/lib/trending-chips";
import { MAX_RESPONSE_BODY_BYTES, readBodyCapped } from "@/lib/collect/read-body";
import { hasCollectionPendingShell } from "@/lib/collect/shell-markers";
import { resolveBuildStamp } from "@/lib/build-stamp";
import { maybeRunDailyLinkSmoke } from "@/lib/metrics/link-smoke-runner";
// REEA-1078 S2 — the daily lane-health pass (7-day auto-retire + canary
// re-admission) rides this same timer, behind the response.
import { COLLECTORS, runLaneCanary } from "@/lib/collect/live-search";
import { maybeRunDailyLaneHealth } from "@/lib/collect/lane-health";
// REEA-1078 AC9 — the daily zone-reachability record the results page reads
// to name a blocked lane as unreachable (same probes /api/echo reports).
import { maybeRunDailyZoneStatus } from "@/lib/collect/zone-status";
import {
  FRESH_CHIP_ALT_RE as CHIP_ALT_RE,
  FRESH_CHIP_RE as CHIP_RE,
} from "@/lib/freshness-chip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// REEA-369: the funnel hops walk pages whose segment ceilings now sit at the
// measured-walk headroom tier (results and product pages; REEA-391), and a
// cold cron call runs home + results + product after a cold start — measured
// ~26 s end to end on the first request after a deploy. The function gets
// headroom above that sum.
export const maxDuration = 60;

const FIXTURE_QUERY = process.env.SMOKE_FIXTURE_QUERY || "sony";
// Results pages stream staged live collections (page ceilings on the 45 s
// measured-walk tier since REEA-391), so the funnel fetches get generous
// per-hop budgets under the cron window: they must cover the measured walk
// (warm ~21 s / cold ~26 s), not the ceiling itself. With the product hop at
// 12 s the first cold request spent its whole chain in connection setup +
// staged collection and aborted a page that answers inside its own budget
// right after (QA REEA-369 repro).
const HOME_TIMEOUT_MS = 12000;
const RESULTS_TIMEOUT_MS = 30000;
const PRODUCT_TIMEOUT_MS = 25000;

// REEA-283/REEA-254/REEA-1092 chip copy: the matcher lives in
// lib/freshness-chip.ts so the probe and scripts/smoke-check.mjs step 4 cannot
// drift. REEA-1069 AC10 introduced "Updated just now" / "Updated 1 minute
// ago"; the old "N minutes ago"-only matcher turned a healthy fresh deploy
// into a health 503 (run 45125867791 rolled the Shelf build back).

async function get(origin: string, path: string, timeoutMs: number) {
  return readHop(origin, path, timeoutMs);
}

/**
 * REEA-398 follow-up — shell-first hop reads with a streamed-results
 * follow-up. Results pages finalize their document in ~21 s (staged live
 * collection; REEA-391 ceilings); the funnel assertions only need the FIRST
 * flush: the shell marker on home, and real cards + a freshness chip + the
 * click-out href on results. This resolves as soon as `until` is satisfied on
 * the accumulated prefix (or the stream ends) and cancels the remaining
 * body, so a healthy deploy flips the tick in ~1-2 s warm instead of paying
 * the whole document walk. Without `until` the hop drains fully, exactly as
 * before. The bounded retry keeps its meaning: a stalled first attempt is
 * retried once against the warmed instance.
 */
async function readHop(
  origin: string,
  path: string,
  timeoutMs: number,
  until?: (html: string) => boolean,
): Promise<{ status: number; html: string }> {
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${origin}${path}`, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "user-agent": "reemco-health/1.0" },
      });
      // REEA-376: both hop shapes now ride the shared bounded read — the
      // shell-first short-circuit on `until`, or a fully drained body, always
      // capped at ~2 MB with an error note on overflow instead of buffering.
      const html = await readBodyCapped(res, MAX_RESPONSE_BODY_BYTES, until);
      if (res.status === 200 || attempt === 1) return { status: res.status, html };
    } catch (e) {
      lastError = (e as Error).message;
    }
  }
  throw new Error(lastError || "fetch failed");
}

// Offer/product cards render as <article class="result-card ..."> (see
// OfferCard/ProductResultCard); skeletons use skeleton-card and never match.
function countCards(html: string): number {
  return (html.match(/class="[^"]*\bresult-card\b/g) || []).length;
}

// Freshness chip matchers as one pair so the until-chain and the assertion
// read the same shape (case-insensitive; legacy spellings allowed).
function countChips(html: string): number {
  return (
    (html.match(new RegExp(CHIP_RE, "gi")) || []).length +
    (html.match(new RegExp(CHIP_ALT_RE, "gi")) || []).length
  );
}

function hasChip(html: string): boolean {
  return countChips(html) >= 1;
}

// REEA-377 build stamp: Vercel injects VERCEL_GIT_COMMIT_SHA at build time
// (same value the build command writes to public/__commit.txt). Not a secret;
// a short SHA is what rollback instructions reference. REEA-1051: on the
// self-hosted image that variable exists only at BUILD time, so the runtime
// falls back to the shipped public/__commit.txt — see lib/build-stamp.ts.
const BUILD_SHA = resolveBuildStamp();

// Last funnel verdict, memory-only — same lifecycle as the rate-limit buckets
// in lib/rate-limit.ts; a new instance simply re-runs the funnel once.
let lastVerdict: { ok: boolean } | null = null;

// REEA-1266 — when the last FULL walk proved the results hop (real cards + a
// freshness chip), and when. A capacity-deferred shell replays that proof
// inside this window instead of re-walking into the same cap. The window also
// bounds "still working": once a provisional streak has run this long with no
// proven walk in it, the probe stops claiming green (see the streak state
// below). Memory-only, like lastVerdict above: a fresh instance has no proof
// yet and says "still working" instead of inventing one. Kept short on
// purpose — a SETTLED zero still fails hard, so the window can never hide a
// genuinely broken funnel.
const HEALTH_VERDICT_REPLAY_MS = readReplayMs();

function readReplayMs(): number {
  const raw = Number(process.env.REEMCO_HEALTH_VERDICT_REPLAY_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 300_000;
}

let lastGoodVerdictAtMs = 0;

// REEA-1266 — bounded "still working": a provisional shell is never an outage
// on its own, but a box that cannot PROVE its funnel for a whole replay window
// is worth a 503, so a permanently stuck funnel cannot read green forever. The
// streak starts on the first provisional answer and clears the moment a walk
// proves the results hop.
let provisionalStreakStartMs = 0;

// Same caller key as the /api/events limiter (client IP from the proxy chain).
function clientKey(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  return (fwd ? fwd.split(",")[0].trim() : "") || req.headers.get("x-real-ip") || "unknown";
}

function verdictResponse(ok: boolean): Response {
  return Response.json({ ok, build: BUILD_SHA }, { status: ok ? 200 : 503 });
}

export async function GET(req: NextRequest): Promise<Response> {
  // REEA-542 AC2 — this hourly tick is the trending-chip invalidation hook:
  // drop the baked homepage chip row so the next render re-reads the event
  // feed. Before the limiter gate on purpose — the bump is a memory-only
  // assignment, so even a replayed-verdict hit still advances the chip hour.
  invalidateTrendingChips();
  // REEA-377: reuse the REEA-37 limiter on the GET path. Inside the window
  // the funnel runs (and caches its verdict); past it the cached verdict is
  // replayed so repeated hits do not each re-walk home → results → product.
  const gate = await checkRateLimitShared(clientKey(req), Date.now());
  if (!gate.allowed && lastVerdict) return verdictResponse(lastVerdict.ok);

  // REEA-1044: the scheduled probe runs on the self-hosted box behind Caddy.
  // Deriving the origin from req.url makes the probe depend on the public
  // hostname resolving and on NAT hairpin (container -> public IP -> Caddy),
  // which is exactly the hop a probe should NOT need in order to prove the
  // app is alive. REEMCO_HEALTH_ORIGIN pins it to the container's own
  // loopback; unset (Vercel) keeps the previous behaviour.
  const origin = process.env.REEMCO_HEALTH_ORIGIN || new URL(req.url).origin;
  // REEA-1078 — daily dead-link smoke, scheduled BEHIND this response. The
  // health timer (reemco-health.timer, REEA-1044) is the only scheduler the
  // deploy path installs, so it is the daily smoke's clock too: the runner's
  // shared-KV day guard makes this a no-op after the day's run. `after()` keeps
  // the (network-heavy) smoke off the health response, and the runner never
  // throws into the verdict.
  after(() => maybeRunDailyLinkSmoke({ origin }));
  // REEA-1078 S2 — dead-lane retirement, once per UTC day, behind the same
  // response: evaluate the 7-day all-failure rule over the persisted per-lane
  // evidence, then canary every retired lane once through its REAL adapter.
  // N consecutive canary answers re-admit the lane; a failure resets the
  // streak. Best-effort — the runner never throws into the verdict.
  // REEA-1078 AC9 — refresh the zone-reachability record once per UTC day so
  // the "unreachable" label never depends on someone hitting /api/echo. Same
  // probe shape as the echo zone cells; behind the response, never in it.
  after(() => maybeRunDailyZoneStatus());
  after(() =>
    maybeRunDailyLaneHealth({
      // Every declared lane: the runner derives the active set from the
      // persisted retirement state, so a canary-readmitted lane is evaluated
      // by the 7-day rule again.
      allLanes: COLLECTORS.map((c) => c.merchant),
      canaryTargets: COLLECTORS.map((c) => ({
        merchant: c.merchant,
        canary: (merchant: string) => runLaneCanary(merchant),
      })),
    }),
  );
  const failed: string[] = [];
  const checks: Record<string, string | number> = {};

  // step 1 — home renders the app shell (header nav is part of the shell).
  try {
    const home = await readHop(origin, "/", HOME_TIMEOUT_MS, (h) => h.includes("site-header"));
    if (home.status !== 200 || !home.html.includes("site-header")) {
      failed.push(`home status=${home.status} shell=${home.html.includes("site-header")}`);
    } else {
      checks.home = "pass";
    }
  } catch (e) {
    failed.push(`home fetch failed: ${(e as Error).message}`);
  }

  // steps 2+4 — fixture query returns real cards wearing freshness chips.
  // The until-chain stops at the first flush that already answers all three
  // assertion inputs (card + chip + click-out href); the late streamed
  // offers are not needed to flip the tick green (REA-398 follow-up).
  let productHref = "";
  try {
    const res = await readHop(
      origin,
      `/results?q=${encodeURIComponent(FIXTURE_QUERY)}`,
      RESULTS_TIMEOUT_MS,
      (h) => countCards(h) >= 1 && hasChip(h) && h.includes('href="/product/'),
    );
    const cards = countCards(res.html);
    const chips = countChips(res.html);
    if (res.status !== 200) {
      failed.push(`results status=${res.status} cards=${cards}`);
    } else if (cards >= 1 && chips >= 1) {
      checks.results = "pass";
      checks.cards = cards;
      checks.freshnessChips = chips;
      const link = res.html.match(/href="(\/product\/[^"]+)"/);
      productHref = link ? link[1] : "";
    } else if (hasCollectionPendingShell(res.html)) {
      // REEA-1266 — a PROVISIONAL shell (render deferred at the collection
      // cap, or finalized while hops were still in flight) is "still working",
      // not a zero-result verdict: the follow-up feed folds the real answer in
      // behind the response. Replay the last PROVEN walk inside the window;
      // with no recent proof, say so instead of inventing one. The streak cap
      // keeps this from masking a funnel that never proves itself again.
      const now = Date.now();
      const proofAgeMs = lastGoodVerdictAtMs > 0 ? now - lastGoodVerdictAtMs : Number.POSITIVE_INFINITY;
      if (provisionalStreakStartMs === 0) provisionalStreakStartMs = now;
      const streakMs = now - provisionalStreakStartMs;
      if (proofAgeMs <= HEALTH_VERDICT_REPLAY_MS) {
        checks.results = "replay";
        checks.replayedVerdictAgeS = Math.round(proofAgeMs / 1000);
      } else if (streakMs > HEALTH_VERDICT_REPLAY_MS) {
        // No proven walk inside a full replay window: "still working" has run
        // out of credit, so this is a real failure, not probe noise.
        checks.results = "unproven";
        checks.provisionalForS = Math.round(streakMs / 1000);
        failed.push(
          `results provisional for ${Math.round(streakMs / 1000)}s with no proven walk`,
        );
      } else {
        checks.results = "still-working";
      }
      // Internals (card counts, which verdict) stay on the console; the served
      // body keeps the minimal `{ok, build}` shape (REEA-377).
      checks.shellCards = cards;
      checks.shellFreshnessChips = chips;
      console.warn(
        `health provisional shell origin=${origin} cards=${cards} chips=${chips} verdict=${checks.results} replayedVerdictAgeS=${checks.replayedVerdictAgeS ?? "none"} provisionalForS=${checks.provisionalForS ?? "none"}`,
      );
    } else if (cards < 1) {
      // A SETTLED document at zero cards is still a real failure: the funnel
      // ran and produced nothing (or every hop failed), so 503 stays honest.
      failed.push(`results status=${res.status} cards=${cards}`);
    } else {
      failed.push(`results has ${cards} cards but no freshness chip`);
    }
  } catch (e) {
    failed.push(`results fetch failed: ${(e as Error).message}`);
  }

  // step 3 — the click-out product page resolves (skip when the first card
  // carries only an external offer link; its liveness is not ours to assert).
  if (failed.length === 0 && productHref) {
    try {
      const prod = await get(origin, productHref, PRODUCT_TIMEOUT_MS);
      if (prod.status !== 200) failed.push(`product ${productHref} status=${prod.status}`);
      else checks.product = "pass";
    } catch (e) {
      failed.push(`product fetch failed: ${(e as Error).message}`);
    }
  }

  const ok = failed.length === 0;
  // REEA-1266 — only a walk that PROVED the results hop (real cards + a
  // freshness chip) refreshes the replay clock and clears the provisional
  // streak. A "still working" answer is green but is not evidence, so it must
  // not extend the window it replays.
  if (ok && checks.results === "pass") {
    lastGoodVerdictAtMs = Date.now();
    provisionalStreakStartMs = 0;
  }
  const checkedAt = new Date().toISOString();
  // Internals to console logs only (REEA-377): Vercel function logs keep the
  // full step detail, the served body stays the minimal {ok, build} shape.
  // REEA-1044: the origin is logged so a failed hop names the URL it tried —
  // on a self-hosted box the difference between loopback and the public
  // hostname is the whole diagnosis.
  const detail = `origin=${origin} fixture=${FIXTURE_QUERY} checks=${JSON.stringify(checks)} failedAt=${JSON.stringify(failed)} checkedAt=${checkedAt}`;
  if (ok) console.log(`health pass ${detail}`);
  else console.error(`health FAIL ${detail}`);
  lastVerdict = { ok };
  return verdictResponse(ok);
}
