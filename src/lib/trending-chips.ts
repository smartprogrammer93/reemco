/**
 * REEA-542 Bet C (spec: REEA-538) — trending homepage chips from the existing
 * anonymous event feed.
 *
 * The chip row keeps position 1 curated (the deterministic QA anchor every QA
 * script matches today) and fills the remaining slots with the top queries of
 * the LAST 24 HOURS from the funnel event store (REEA-37). AC1: everything is
 * server-side aggregation over fields the ingestion endpoint already keeps —
 * the query string on search_submitted events. No cookies, no sessions, no
 * per-user state, nothing newly collected. The tally reuses the weekly
 * report's own top-query convention (report.ts: search_submitted counts only,
 * count descending, case-folded name ascending).
 *
 * Stability (AC2): the chip set is baked once per hour into a per-instance
 * memory memo — the same lifecycle as the health verdict in
 * app/api/health/route.ts and the per-instance memos in lib/query-cache.ts.
 * Repeated loads inside the hour render the identical set; the hourly Vercel
 * cron GET of /api/health calls invalidateTrendingChips(), so a warm instance
 * re-bakes on the hourly tick instead of waiting out the TTL.
 *
 * Degradation + fallback (AC3): a failed feed read, or fewer than
 * MIN_ELIGIBLE_QUERIES distinct eligible queries in the window (immature
 * volume — Bet C is scheduled after two weeks of accumulated weekly-report
 * data), falls the whole row back to the curated set. The row never renders
 * empty and never blocks on the feed.
 *
 * Click warmth stays the caller's business: the homepage pre-warms every
 * rendered chip through the same after() live-collection chain the curated
 * examples already use (REEA-437), so trending clicks land warm too.
 */
import type { FunnelEvent } from "@/lib/events";
import { readEvents } from "@/lib/event-store";
import { aggregateWeekly } from "@/lib/report";
import type { SharedKv } from "@/lib/collect/kv";

/** AC2: one baked chip set serves unchanged for an hour. */
export const CHIP_CACHE_TTL_MS = 60 * 60 * 1000;

/** AC3: fewer distinct eligible queries than this in the window → curated set. */
export const MIN_ELIGIBLE_QUERIES = 3;

/** Display cap so a long typed query keeps the hero row scannable; the Link
 *  href always carries the FULL query string, the label clips on a word
 *  boundary with an ellipsis. */
const DISPLAY_MAX_CHARS = 64;

/** One chip: the query to run (href + pre-warm) and what the pill shows. */
export interface TrendingChip {
  query: string;
  label: string;
}

export interface TrendingChipOptions {
  now?: number;
  /** Remaining slots after the curated anchor; defaults to curated.length - 1. */
  slots?: number;
  minEligible?: number;
}

function truncate(query: string): string {
  if (query.length <= DISPLAY_MAX_CHARS) return query;
  const head = query.slice(0, DISPLAY_MAX_CHARS);
  const atSpace = head.lastIndexOf(" ");
  return `${(atSpace > 20 ? head.slice(0, atSpace) : head).trimEnd()}…`;
}

function toChip(query: string): TrendingChip {
  const q = query.trim();
  return { query: q, label: truncate(q) };
}

/**
 * Pure selection: position 1 is curated[0]; the rest come from the last-24h
 * top-query tally. Eligible = distinct (case-folded) queries that are not the
 * anchor itself — a query identical to the anchor would just double the first
 * chip. Below minEligible eligible queries the curated set is returned as-is.
 */
export function selectTrendingChips(
  events: FunnelEvent[],
  curated: readonly string[],
  opts: TrendingChipOptions = {},
): TrendingChip[] {
  const now = opts.now ?? Date.now();
  const minEligible = opts.minEligible ?? MIN_ELIGIBLE_QUERIES;
  const anchor = (curated[0] ?? "").trim();
  const slots = opts.slots ?? Math.max(curated.length - 1, 1);

  // Same tally as the weekly report (search_submitted queries only, count
  // desc, name asc), narrowed to a 1-day window. Draw a slightly wider pool
  // than needed so ineligible entries cannot starve the row.
  const report = aggregateWeekly(events, {
    now,
    windowDays: 1,
    topN: minEligible + curated.length + 4,
  });

  const seen = new Set<string>();
  if (anchor) seen.add(anchor.toLowerCase());
  const eligible: TrendingChip[] = [];
  for (const entry of report.top_queries) {
    const chip = toChip(entry.query);
    if (!chip.query) continue;
    const key = chip.query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    eligible.push(chip);
  }

  if (eligible.length < minEligible) {
    return curated.map(toChip).filter((c) => c.query).slice(0, slots + 1);
  }
  const lead = anchor ? [toChip(anchor)] : [];
  return [...lead, ...eligible.slice(0, slots)];
}

/** One baked row per instance/hour — memory-only, same contract as the
 *  health verdict and the rate-limit buckets: a new instance simply re-bakes. */
let chipCache: { bakedAt: number; chips: TrendingChip[] } | null = null;

/** Drop the baked row so the next render re-reads the feed. Called by the
 *  hourly /api/health cron tick (AC2's invalidation hook). */
export function invalidateTrendingChips(): void {
  chipCache = null;
}

export interface TrendingChipsLoaderOptions {
  now?: number;
  dir?: string;
  kv?: SharedKv | null;
}

/**
 * Read-through for the homepage: cached row inside the hour, otherwise re-bake
 * from the event feed. Any feed failure degrades to the curated set (baked for
 * the hour too, so a flaky feed cannot make every render pay for it).
 */
export async function getTrendingChips(
  curated: readonly string[],
  opts: TrendingChipsLoaderOptions = {},
): Promise<TrendingChip[]> {
  const now = opts.now ?? Date.now();
  if (chipCache && now - chipCache.bakedAt < CHIP_CACHE_TTL_MS) {
    return chipCache.chips;
  }
  let chips: TrendingChip[];
  try {
    const events = await readEvents({ dir: opts.dir, kv: opts.kv });
    chips = selectTrendingChips(events, curated, { now });
  } catch {
    chips = curated.map(toChip).filter((c) => c.query);
  }
  chipCache = { bakedAt: now, chips };
  return chips;
}
