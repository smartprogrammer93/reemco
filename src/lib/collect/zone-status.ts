/**
 * REEA-1078 AC9 — lane reachability from the existing `/api/echo` zone status.
 *
 * Why: a lane blocked at the edge (Lulu Hypermarket and Next Store today — the
 * Cloudflare zones answer every hop shape with a 403 from this egress) renders
 * a silent zero, and a silent zero reads to the shopper as "we don't stock
 * it". The zone status is not unknown: `/api/echo` already probes exactly
 * those zones from the deployed runtime. This module turns that probe into a
 * persisted, aggregate reachability record the results page can read at
 * render time, so the coverage sentence can name the lane as UNREACHABLE
 * instead of letting it look like a coverage statement.
 *
 * Source of truth, deliberately not a second opinion: the probe here rides the
 * SAME handshake the adapters ride (`fetchThroughChallenge`), with the same
 * hop shape and the same answered rules the `/api/echo` zone cells use, and
 * `/api/echo` also persists its own probe result through
 * `recordEchoZoneStatus`. No raw status codes or internals reach shopper copy:
 * the UI only ever reads a boolean per zone.
 *
 * Data posture: one boolean + one timestamp per zone, retailer names only. No
 * per-query, per-user or per-card data. Every store call is best-effort — a
 * missing or stale record simply means "no unreachable label", never a failed
 * render (graceful degradation).
 */
import { getSharedKv } from "@/lib/collect/kv";
import { fetchThroughChallenge } from "@/lib/collect/search-fallback";
import { jsdClearedHtml } from "@/lib/collect/live-search";

/** Shared-KV key holding the per-zone reachability record. */
export const ZONE_STATUS_KEY = "zone_status:v1";

/** Keep the record longer than the daily probe cadence. */
export const ZONE_STATUS_TTL_S = 36 * 60 * 60;

/**
 * How old a probe may be before the label is withheld. The daily health tick
 * refreshes the record; a record older than this is treated as unknown rather
 * than as a stale claim about a lane that may have recovered.
 */
export const ZONE_STATUS_FRESH_MS = 26 * 60 * 60 * 1000;

/** Same bounded probe window `/api/echo` uses for its zone cells. */
const ZONE_WINDOW_MS = 8_000;

/** UTC day stamp: the day the last successful zone-status run ran. */
export const ZONE_STATUS_DAY_KEY = "zone_status:last_run_day";

export interface ZoneStatusEntry {
  /** Zone host the probe rides (echo's `zones` key). */
  host: string;
  /** Retailer name exactly as the coverage notes spell it. */
  merchant: string;
  /** true = the zone answered this egress; false = it is blocked/unreachable. */
  reachable: boolean;
  /** ISO timestamp of the observation. */
  checkedAt: string;
}

export interface ZoneStatusState {
  version: 1;
  zones: Record<string, ZoneStatusEntry>;
}

export interface ZoneStatusRead {
  state: ZoneStatusState;
  /** false = the shared store could not be read (fail open: no labels). */
  reachable: boolean;
}

export function emptyZoneStatusState(): ZoneStatusState {
  return { version: 1, zones: {} };
}

function cleanHost(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120) : "";
}

function cleanIso(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

/** Defensive normalization of a stored blob (a legacy/hand-edited value must
 *  never break a render). */
export function normalizeZoneStatusState(raw: unknown): ZoneStatusState {
  const state = emptyZoneStatusState();
  if (!raw || typeof raw !== "object") return state;
  const zones = (raw as { zones?: unknown }).zones;
  if (!zones || typeof zones !== "object") return state;
  for (const [hostRaw, entryRaw] of Object.entries(zones as Record<string, unknown>)) {
    const host = cleanHost(hostRaw);
    if (!host || !entryRaw || typeof entryRaw !== "object") continue;
    const e = entryRaw as Record<string, unknown>;
    const checkedAt = cleanIso(e.checkedAt);
    if (!checkedAt) continue;
    state.zones[host] = {
      host,
      merchant: cleanHost(e.merchant),
      reachable: e.reachable === true,
      checkedAt,
    };
  }
  return state;
}

/**
 * The zones whose reachability the coverage sentence can speak to, with the
 * merchant spelling the notes carry and the answered rule each cell uses —
 * the SAME shapes `/api/echo` reports (see the zone cells in
 * src/app/api/echo/route.ts). A zone whose merchant is not in the default
 * fan-out is harmless: no note means no label.
 */
export const LANE_ZONES: readonly {
  host: string;
  merchant: string;
  url: string;
  /** The zone's own answered rule, identical to the collector/echo rule. */
  answered: (status: number, body: string) => boolean;
  /**
   * The clearance-tier rule: the same zone judged from the jsdom-cleared body
   * the collector falls through to when the handshake landed on a block page.
   * A block page that jsdom returns unchanged is still not an answer.
   */
  clearedAnswered: (body: string) => boolean;
}[] = [
  {
    host: "www.luluhypermarket.com",
    merchant: "Lulu Hypermarket",
    url: "https://www.luluhypermarket.com/en/search?query=basmati+rice",
    // The collector only accepts a body carrying the JSON-LD blocks; the CF
    // interstitial passes a plain length check but carries none.
    answered: (status, body) => status === 200 && body.includes("application/ld+json"),
    clearedAnswered: (body) => body.includes("application/ld+json"),
  },
  {
    host: "www.nextstore.com.kw",
    merchant: "Next Store",
    url: "https://www.nextstore.com.kw/catalogsearch/result/index/?q=iphone%2017",
    // Echo's cell rule for this zone: a 200 answer from the SSR catalogsearch
    // route is the re-admission tripwire.
    answered: (status) => status === 200,
    clearedAnswered: (body) =>
      body.length > 0 && !/Just a moment|cf-error-details|Attention Required/i.test(body),
  },
];

/** Merchant names whose zone is recorded unreachable and still fresh. */
export function unreachableMerchants(
  state: ZoneStatusState,
  now = Date.now(),
): string[] {
  const out = new Set<string>();
  for (const entry of Object.values(state.zones)) {
    if (entry.reachable) continue;
    const at = Date.parse(entry.checkedAt);
    if (!Number.isFinite(at) || now - at > ZONE_STATUS_FRESH_MS) continue;
    if (entry.merchant) out.add(entry.merchant);
  }
  return [...out].sort();
}

/**
 * Probe every lane zone exactly the way the collector/echo hop does: the
 * shared verified-crawler handshake, then (only when the handshake did not
 * answer) the bounded jsdom clearance tier the Lulu collector falls through
 * to. Never throws: an abort/timeout is an unreachable observation.
 */
export async function probeLaneZones(
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<ZoneStatusEntry[]> {
  const checkedAt = new Date(now).toISOString();
  const entries: ZoneStatusEntry[] = [];
  for (const zone of LANE_ZONES) {
    let reachable = false;
    try {
      const res = await fetchThroughChallenge(fetchImpl, zone.url, {}, AbortSignal.timeout(ZONE_WINDOW_MS));
      const body = await res.text();
      reachable = zone.answered(res.status, body);
    } catch {
      // Rotation exhaustion / window abort: the clearance tier below still
      // gets its own chance, exactly like the collector's fall-through.
      reachable = false;
    }
    if (!reachable) {
      // Same second half as echo's clearance tier: the collector can still
      // answer through jsdom when the handshake landed on the block page.
      const cleared = await jsdClearedHtml(fetchImpl, zone.url).catch(() => "");
      reachable = zone.clearedAnswered(cleared);
    }
    entries.push({ host: zone.host, merchant: zone.merchant, reachable, checkedAt });
  }
  return entries;
}

/**
 * Persist the zone cells `/api/echo` just observed. The echo route reports
 * `status` (0 on a failed hop) and `clearedBytes`; both are mapped onto the
 * same boolean the results page reads, so the two writers can never disagree
 * about what "answered" means.
 */
export function zoneEntriesFromEcho(
  zones: Record<string, { status?: number; clearedBytes?: number } | undefined>,
  now = Date.now(),
): ZoneStatusEntry[] {
  const checkedAt = new Date(now).toISOString();
  const entries: ZoneStatusEntry[] = [];
  for (const zone of LANE_ZONES) {
    const cell = zones[zone.host];
    if (!cell) continue;
    const reachable = (cell.status ?? 0) === 200 || (cell.clearedBytes ?? 0) > 0;
    entries.push({ host: zone.host, merchant: zone.merchant, reachable, checkedAt });
  }
  return entries;
}

/** Merge observations into the stored record (later observations win). */
export function mergeZoneStatus(
  state: ZoneStatusState,
  entries: readonly ZoneStatusEntry[],
): ZoneStatusState {
  const next: ZoneStatusState = {
    version: 1,
    zones: Object.fromEntries(Object.entries(state.zones).map(([h, e]) => [h, { ...e }])),
  };
  for (const entry of entries) {
    if (!entry.host) continue;
    next.zones[entry.host] = { ...entry };
  }
  return next;
}

export async function readZoneStatus(opts: {
  kv?: ReturnType<typeof getSharedKv>;
} = {}): Promise<ZoneStatusRead> {
  const kv = opts.kv === undefined ? getSharedKv() : opts.kv;
  if (!kv) return { state: emptyZoneStatusState(), reachable: false };
  const raw = await kv.get(ZONE_STATUS_KEY).catch(() => null);
  if (raw === null) return { state: emptyZoneStatusState(), reachable: true };
  try {
    return { state: normalizeZoneStatusState(JSON.parse(raw)), reachable: true };
  } catch {
    return { state: emptyZoneStatusState(), reachable: false };
  }
}

export async function writeZoneStatus(
  state: ZoneStatusState,
  opts: { kv?: ReturnType<typeof getSharedKv> } = {},
): Promise<boolean> {
  const kv = opts.kv === undefined ? getSharedKv() : opts.kv;
  if (!kv) return false;
  return kv.set(ZONE_STATUS_KEY, JSON.stringify(state), ZONE_STATUS_TTL_S).catch(() => false);
}

/**
 * Record the echo cells into the shared record. Best-effort and safe to call
 * from a deferred tail: a store failure just leaves the previous record (or
 * none) in place.
 */
export async function recordEchoZoneStatus(
  zones: Record<string, { status?: number; clearedBytes?: number } | undefined>,
  opts: { now?: number; kv?: ReturnType<typeof getSharedKv> } = {},
): Promise<boolean> {
  const kv = opts.kv === undefined ? getSharedKv() : opts.kv;
  if (!kv) return false;
  const read = await readZoneStatus({ kv });
  if (!read.reachable) return false;
  const merged = mergeZoneStatus(read.state, zoneEntriesFromEcho(zones, opts.now ?? Date.now()));
  return writeZoneStatus(merged, { kv });
}

/** Serve-path read, memoized briefly per instance; fail-open on any problem. */
const MEMO_MS = 60_000;
let memo: { at: number; state: ZoneStatusState } | null = null;

export async function readZoneStatusMemoized(opts: {
  now?: number;
  kv?: ReturnType<typeof getSharedKv>;
} = {}): Promise<ZoneStatusState> {
  const now = opts.now ?? Date.now();
  if (memo && now - memo.at < MEMO_MS) return memo.state;
  const read = await readZoneStatus({ kv: opts.kv });
  // Fail open AND memoize the failure: a store blip must not re-pay the KV
  // timeout on every serve for the next minute (AC-8 latency budget).
  const state = read.reachable ? read.state : (memo?.state ?? emptyZoneStatusState());
  memo = { at: now, state };
  return state;
}

/** The merchant names the results page may label as unreachable right now. */
export async function readUnreachableLanes(opts: {
  now?: number;
  kv?: ReturnType<typeof getSharedKv>;
} = {}): Promise<string[]> {
  const state = await readZoneStatusMemoized(opts);
  return unreachableMerchants(state, opts.now ?? Date.now());
}

/** Test hook: drop the serve-path memo. */
export function resetZoneStatusMemo(): void {
  memo = null;
}

let zoneStatusRunning = false;
let lastZoneStatusDay = "";

export interface DailyZoneStatusDeps {
  now?: () => number;
  kv?: ReturnType<typeof getSharedKv>;
  fetchImpl?: typeof fetch;
  /** Tests: skip the day-guard read. */
  alreadyRanToday?: boolean;
}

/**
 * AC9 — daily zone reachability record, scheduled behind the existing health
 * timer (no new host unit). The record is what lets the results page say
 * "unreachable" instead of letting a blocked lane's silent zero read as a
 * coverage statement. The day guard is stamped only after a successful write,
 * so a transient failure retries on the next tick instead of leaving a gap.
 */
export async function maybeRunDailyZoneStatus(
  deps: DailyZoneStatusDeps = {},
): Promise<ZoneStatusEntry[] | null> {
  if (zoneStatusRunning) return null;
  const now = deps.now ?? Date.now;
  const today = new Date(now()).toISOString().slice(0, 10);
  const kv = deps.kv === undefined ? getSharedKv() : deps.kv;
  let last = lastZoneStatusDay;
  if (kv) {
    const stored = await kv.get(ZONE_STATUS_DAY_KEY).catch(() => null);
    if (stored) last = stored.trim();
  }
  if (deps.alreadyRanToday || last === today) return null;

  zoneStatusRunning = true;
  try {
    const entries = await probeLaneZones(deps.fetchImpl ?? fetch, now());
    const read = await readZoneStatus({ kv });
    if (!read.reachable && kv) return null;
    const merged = mergeZoneStatus(read.state, entries);
    const written = await writeZoneStatus(merged, { kv });
    if (!written && kv) return null;
    lastZoneStatusDay = today;
    if (kv) {
      await kv.set(ZONE_STATUS_DAY_KEY, today, ZONE_STATUS_TTL_S).catch(() => false);
    }
    memo = null;
    console.log(
      `zone status ${today}: ${entries.map((e) => `${e.merchant}=${e.reachable ? "answered" : "unreachable"}`).join(" ")}`,
    );
    return entries;
  } catch (e) {
    console.error("zone status run failed", e);
    return null;
  } finally {
    zoneStatusRunning = false;
  }
}

/** Test hook: drop the daily-run memory guard. */
export function resetZoneStatusRunState(): void {
  zoneStatusRunning = false;
  lastZoneStatusDay = "";
  memo = null;
}
