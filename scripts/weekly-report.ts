/**
 * REEA-37 — weekly funnel report CLI (AC-4).
 *
 * Usage: node --experimental-strip-types scripts/weekly-report.ts [days]
 * Reads the JSONL event store (EVENTS_DIR, default ./.events, merged with the
 * shared-KV blob when bound — REEA-233), prunes raw events past the 90-day
 * retention window, prints the weekly aggregate.
 */
import { EVENTS_DIR, pruneOldEvents, readEvents } from "../src/lib/event-store.ts";
import { aggregateWeekly } from "../src/lib/report.ts";

const days = Number.parseInt(process.argv[2] ?? "", 10);
const windowDays = Number.isFinite(days) && days >= 1 ? Math.min(days, 90) : 7;

const pruned = await pruneOldEvents();
const events = await readEvents();
const report = aggregateWeekly(events, { windowDays });

console.log(`Event store: ${EVENTS_DIR} (${events.length} retained events, ${pruned} pruned)`);
console.log(JSON.stringify(report, null, 2));
const rate = (r: number | null) => (r == null ? "n/a" : `${(r * 100).toFixed(1)}%`);
console.log(
  `\nSearch->click-out rate: ${rate(report.click_out_rate)} · zero-result rate: ${rate(report.zero_result_rate)}`,
);
