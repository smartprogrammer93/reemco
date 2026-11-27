/**
 * REEA-1237 (PM scope extension, v5 improvement read) — top query terms.
 *
 * W48 named the dead-end POPULATION (4.46% zero-offer, 2.87% filtered-empty)
 * but not the TERMS that carry it, so the Pareto fix (repair the ~20 terms
 * that carry demand) could not be targeted. This pins the additive counter:
 *
 * - aggregate `{term, count}` rows only, with the two dead-end marks — no
 *   user id, no session id, no per-serve row;
 * - normalization removes noise only (case, whitespace, control chars, 80-char
 *   cap) and does NOT stem, so Arabic and Latin terms stay comparable;
 * - `/api/metrics/weekly` publishes `top_queries` per week, capped at 200,
 *   including zero-offer and filtered-empty terms, marked as such;
 * - bot/health-check serves never enter the Pareto (the caller gates them with
 *   the shared UA predicate, so a QA probe's term cannot dominate it).
 *
 * Also pins the local-layer write path: `readLocalTerms` returns the WEEK MAP
 * (the file's `weeks` object), not a wrapper, so a fold that degrades to the
 * local layer must index it directly — reading `.weeks` off it would throw and
 * silently lose every degraded fold.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_QUERY_TERM_LENGTH,
  MAX_QUERY_TERMS,
  MAX_STORED_QUERY_TERMS,
  QUERY_TERMS_KV_PREFIX,
  foldQueryTerm,
  normalizeQueryTerm,
  readQueryTerms,
  recordQueryTerm,
  topQueryTerms,
  type QueryTermsMap,
  type WeekQueryTerms,
} from "@/lib/query-terms";
import type { SharedKv } from "@/lib/collect/kv";
import { weeklyResponse } from "@/app/api/metrics/weekly/route";
import { emptyWeek, isoWeekKey, type WeekCountersMap } from "@/lib/metrics";

const WEEK_MS = Date.UTC(2026, 11, 2); // 2026-W49, a complete shopper-basis week
const WEEK = isoWeekKey(WEEK_MS);

const dirs: string[] = [];

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "reemco-query-terms-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/** A faultable fake of the shared store, same shape the metrics tests use. */
function fakeKv(seed: Record<string, string> = {}) {
  const entries = new Map<string, string>(Object.entries(seed));
  const flags = {
    failGet: false,
    failSet: false,
    failKeys: false,
    failMget: false,
    sets: [] as { key: string; value: string; ttl: number }[],
  };
  const kv: SharedKv = {
    async get(key: string) {
      if (flags.failGet) throw new Error("store down");
      return entries.get(key) ?? null;
    },
    async set(key: string, value: string, ttlSeconds: number) {
      flags.sets.push({ key, value, ttl: ttlSeconds });
      if (flags.failSet) return false;
      entries.set(key, value);
      return true;
    },
    async keys(pattern: string) {
      if (flags.failKeys) return null;
      const prefix = pattern.replace(/\*$/, "");
      return [...entries.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    async mget(keys: string[]) {
      if (flags.failMget) return null;
      return keys.map((k) => entries.get(k) ?? null);
    },
  };
  return { kv, entries, flags };
}

describe("REEA-1237 — term normalization removes noise only, never stems", () => {
  it("case-folds and collapses whitespace", () => {
    expect(normalizeQueryTerm("  Sony   XM5  ")).toBe("sony xm5");
    expect(normalizeQueryTerm("SONY")).toBe("sony");
  });

  it("strips control characters (a pasted tab/newline cannot split a term)", () => {
    expect(normalizeQueryTerm("sony\u0000xm5")).toBe("sony xm5");
    expect(normalizeQueryTerm("sony\txm5")).toBe("sony xm5");
    expect(normalizeQueryTerm("sony\u007f")).toBe("sony");
  });

  it("keeps Arabic terms as typed — comparable with Latin terms, not stemmed", () => {
    expect(normalizeQueryTerm("سماعات سوني")).toBe("سماعات سوني");
    // no stemming: the two forms stay distinct
    expect(normalizeQueryTerm("running shoes")).toBe("running shoes");
    expect(normalizeQueryTerm("run")).toBe("run");
    expect(normalizeQueryTerm("Running")).toBe(normalizeQueryTerm("running"));
  });

  it("caps a long term and drops empties", () => {
    const long = "a".repeat(200);
    expect(normalizeQueryTerm(long)).toHaveLength(MAX_QUERY_TERM_LENGTH);
    expect(normalizeQueryTerm("")).toBeNull();
    expect(normalizeQueryTerm("   \t ")).toBeNull();
    expect(normalizeQueryTerm(undefined)).toBeNull();
    expect(normalizeQueryTerm(42)).toBeNull();
  });
});

describe("REEA-1237 — the aggregate fold and the 200-row Pareto cap", () => {
  it("counts serves per term and carries the two dead-end marks independently", () => {
    const map: WeekQueryTerms = {};
    foldQueryTerm(map, "sony xm5", { zeroOffer: true });
    foldQueryTerm(map, "sony xm5");
    foldQueryTerm(map, "sony xm5", { filteredEmpty: true });
    expect(map["sony xm5"]).toEqual({ count: 3, zero_offer: 1, filtered_empty: 1 });
    // a filtered-empty serve can also be zero-offer: the marks are independent
    foldQueryTerm(map, "sony xm5", { zeroOffer: true, filteredEmpty: true });
    expect(map["sony xm5"]).toEqual({ count: 4, zero_offer: 2, filtered_empty: 2 });
  });

  it("keeps the highest-count terms up to the STORED cap, never unbounded cardinality", () => {
    const map: WeekQueryTerms = {};
    for (let i = 0; i < MAX_STORED_QUERY_TERMS + 25; i++) {
      foldQueryTerm(map, `term-${String(i).padStart(4, "0")}`);
    }
    // give the first 500 terms a second serve: count must outrank the tail
    for (let i = 0; i < 500; i++) foldQueryTerm(map, `term-${String(i).padStart(4, "0")}`);
    expect(Object.keys(map)).toHaveLength(MAX_STORED_QUERY_TERMS);
    expect(map["term-0000"]?.count).toBe(2);
    // the 25 evicted rows are all count-1 tail terms, never demand: the
    // second serve promoted 500 terms, and every count-2 term survived.
    expect(map["term-0999"]).toBeUndefined();
    expect(Object.values(map).filter((c) => c.count === 1)).toHaveLength(500);
    expect(Object.values(map).filter((c) => c.count === 2)).toHaveLength(500);
    // the PUBLISHED list is still the PM's 200-row cap
    expect(topQueryTerms(map)).toHaveLength(MAX_QUERY_TERMS);
  });

  it("admits a term that first appears AFTER saturation, so the Pareto cannot freeze", () => {
    const map: WeekQueryTerms = {};
    for (let i = 0; i < MAX_STORED_QUERY_TERMS; i++) {
      foldQueryTerm(map, `seed-${String(i).padStart(4, "0")}`);
    }
    expect(Object.keys(map)).toHaveLength(MAX_STORED_QUERY_TERMS);
    // A brand-new term at count 1 displaces a count-1 tail term (the boundary
    // tie goes to the just-folded term), so it can keep accumulating instead
    // of being re-evicted at count 1 forever.
    foldQueryTerm(map, "trending-term");
    expect(map["trending-term"]?.count).toBe(1);
    foldQueryTerm(map, "trending-term");
    foldQueryTerm(map, "trending-term");
    expect(map["trending-term"]?.count).toBe(3);
    expect(Object.keys(map)).toHaveLength(MAX_STORED_QUERY_TERMS);
    // Once every stored term carries demand (count >= 2), a one-off term at
    // count 1 cannot displace it: that is the honest long tail, not demand.
    for (const term of Object.keys(map)) {
      while ((map[term]?.count ?? 0) < 2) foldQueryTerm(map, term);
    }
    foldQueryTerm(map, "one-off");
    expect(map["one-off"]).toBeUndefined();
    expect(map["trending-term"]?.count).toBeGreaterThanOrEqual(3);
  });

  it("publishes highest-count first, capped, with marks; limit is clamped", () => {
    const map: WeekQueryTerms = {};
    foldQueryTerm(map, "sony", { zeroOffer: true });
    foldQueryTerm(map, "sony");
    foldQueryTerm(map, "iphone");
    foldQueryTerm(map, "jbl", { filteredEmpty: true });
    const rows = topQueryTerms(map);
    expect(rows[0]).toEqual({ term: "sony", count: 2, zero_offer: 1, filtered_empty: 0 });
    expect(rows.map((r) => r.term)).toEqual(["sony", "iphone", "jbl"]);
    expect(topQueryTerms(map, 2)).toHaveLength(2);
    expect(topQueryTerms(map, 0)).toHaveLength(0);
    expect(topQueryTerms(map, 10_000)).toHaveLength(3);
  });
});

describe("REEA-1237 — aggregate store: one fold lands in exactly one layer", () => {
  it("records to the shared store and reads it back (no local copy)", async () => {
    const { kv } = fakeKv();
    const dir = tmpDir();
    await recordQueryTerm("Sony  XM5", { zeroOffer: true }, { now: WEEK_MS, kv, dir });
    const read = await readQueryTerms({ now: WEEK_MS, kv, dir });
    expect(read.weeks[WEEK]?.["sony xm5"]).toEqual({ count: 1, zero_offer: 1, filtered_empty: 0 });
    // the fold went to KV only: the local layer stayed empty
    expect((await readQueryTerms({ now: WEEK_MS, kv: null, dir })).weeks).toEqual({});
  });

  it("falls back to the local layer when the store write fails, and the read sums layers", async () => {
    const { kv, flags } = fakeKv();
    flags.failSet = true;
    const dir = tmpDir();
    // The degraded fold must LAND (this is the regression the local-layer
    // indexing bug caused: reading `.weeks` off the week map threw and the
    // fold vanished).
    await recordQueryTerm("jbl tune", { filteredEmpty: true }, { now: WEEK_MS, kv, dir });
    const localOnly = await readQueryTerms({ now: WEEK_MS, kv: null, dir });
    expect(localOnly.source).toBe("local");
    expect(localOnly.weeks[WEEK]?.["jbl tune"]).toEqual({
      count: 1,
      zero_offer: 0,
      filtered_empty: 1,
    });
    // With the store reachable again the read sums the degraded layer on top.
    const merged = await readQueryTerms({ now: WEEK_MS, kv, dir });
    expect(merged.weeks[WEEK]?.["jbl tune"]?.count).toBe(1);
  });

  it("a store read failure degrades to the local layer instead of failing the read", async () => {
    const { kv, flags } = fakeKv();
    flags.failGet = true;
    flags.failKeys = true;
    flags.failMget = true;
    const dir = tmpDir();
    await recordQueryTerm("sony", {}, { now: WEEK_MS, kv, dir });
    const read = await readQueryTerms({ now: WEEK_MS, kv, dir });
    expect(read.weeks[WEEK]?.["sony"]?.count).toBe(1);
  });

  it("does not lose the week when the batched KV read is unreachable", async () => {
    const { kv, entries, flags } = fakeKv();
    const dir = tmpDir();
    await recordQueryTerm("sony", {}, { now: WEEK_MS, kv, dir });
    expect(entries.get(`${QUERY_TERMS_KV_PREFIX}:${WEEK}`)).toBeTruthy();
    // keys() answers, but mget() is unreachable: the read must fall through
    // to per-week gets, not read the batch null as an empty keyspace.
    flags.failMget = true;
    const read = await readQueryTerms({ now: WEEK_MS, kv, dir });
    expect(read.weeks[WEEK]?.["sony"]?.count).toBe(1);
  });

  it("stores no identifier: the persisted blob is term → three integers", async () => {
    const { kv, entries } = fakeKv();
    await recordQueryTerm("sony", { zeroOffer: true }, { now: WEEK_MS, kv });
    const blob = JSON.parse(entries.get(`${QUERY_TERMS_KV_PREFIX}:${WEEK}`) as string) as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(blob)).toEqual(["sony"]);
    expect(Object.keys(blob.sony).sort()).toEqual(["count", "filtered_empty", "zero_offer"]);
    expect(Object.values(blob.sony).every((v) => Number.isInteger(v))).toBe(true);
    // no session/user/query-id key anywhere in the stored blob
    const serialized = JSON.stringify(blob);
    expect(serialized).not.toMatch(/session|userId|queryId|fingerprint/i);
  });
});

describe("REEA-1237 — /api/metrics/weekly publishes the top-query Pareto", () => {
  function termsForWeek(): QueryTermsMap {
    const map: WeekQueryTerms = {};
    foldQueryTerm(map, "sony xm5", { zeroOffer: true });
    foldQueryTerm(map, "sony xm5");
    foldQueryTerm(map, "iphone 15", { filteredEmpty: true });
    foldQueryTerm(map, "سماعات سوني");
    return { [WEEK]: map };
  }

  it("publishes {term, count, zero_offer, filtered_empty} rows, highest count first", async () => {
    const res = weeklyResponse(
      { weeks: { [WEEK]: emptyWeek() }, source: "local", kvReadFailed: false },
      { [WEEK]: 2 },
      8,
      { [WEEK]: 4 },
      termsForWeek(),
    );
    const body = (await res.json()) as {
      weeks: Record<string, Record<string, unknown>>;
      methodology: Record<string, string>;
    };
    const rows = body.weeks[WEEK].top_queries as {
      term: string;
      count: number;
      zero_offer: number;
      filtered_empty: number;
    }[];
    expect(rows[0]).toEqual({ term: "sony xm5", count: 2, zero_offer: 1, filtered_empty: 0 });
    // zero-offer and filtered-empty terms are INCLUDED and marked, not dropped
    expect(rows).toContainEqual({ term: "iphone 15", count: 1, zero_offer: 0, filtered_empty: 1 });
    // Arabic term is published as typed (no stemming, no transliteration)
    expect(rows.map((r) => r.term)).toContain("سماعات سوني");
    // aggregate-only: no identifier in a row
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["count", "filtered_empty", "term", "zero_offer"]);
    }
    // methodology names the normalization + the bot exclusion
    const m = body.methodology.top_queries;
    expect(m).toContain("capped at 200");
    expect(m).toContain("NOT stemmed");
    expect(m).toContain("Bot/health-check serves are not recorded");
    expect(m).toContain("no user id, no session id, no per-serve row");
  });

  it("publishes an empty list for a week with no recorded terms (never absent)", async () => {
    const res = weeklyResponse(
      { weeks: { [WEEK]: emptyWeek() }, source: "local", kvReadFailed: false },
      {},
      8,
      {},
    );
    const body = (await res.json()) as { weeks: Record<string, Record<string, unknown>> };
    expect(body.weeks[WEEK].top_queries).toEqual([]);
  });

  it("caps the published list at 200 rows even if the store holds more", async () => {
    const map: WeekQueryTerms = {};
    for (let i = 0; i < 260; i++) foldQueryTerm(map, `t-${String(i).padStart(3, "0")}`);
    const res = weeklyResponse(
      { weeks: { [WEEK]: emptyWeek() }, source: "local", kvReadFailed: false },
      {},
      8,
      {},
      { [WEEK]: map },
    );
    const body = (await res.json()) as { weeks: Record<string, Record<string, unknown>> };
    expect((body.weeks[WEEK].top_queries as unknown[]).length).toBe(MAX_QUERY_TERMS);
  });
});
