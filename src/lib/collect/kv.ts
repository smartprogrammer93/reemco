/**
 * REEA-92 — shared KV access for collect-job state.
 *
 * Collect jobs are created by POST /api/products/:id/collect and polled by
 * GET /api/collect-jobs/:jobId; on Vercel those can be different serverless
 * instances, each with its own memory + /tmp. Job snapshots therefore ride on
 * a shared KV store so a follow-up request on ANY instance continues the same
 * job instead of falling back to the client-side restart path.
 *
 * Backend is the Vercel KV / Upstash REST interface (`KV_REST_API_URL` +
 * `KV_REST_API_TOKEN`, injected automatically when a KV store is bound to the
 * project). When no binding is configured (local dev, tests) callers fall back
 * to the per-process disk cache — see store.ts. Every call is best-effort with
 * a short timeout: a KV hiccup degrades to the local cache, never to a failed
 * request. Tokens are never logged.
 */

const KV_TIMEOUT_MS = 2500;

/**
 * REEA-996 — one short backoff retry inside getChecked(): a transient KV
 * blip (Upstash 429, a cold-connection timeout) must not masquerade as a
 * store read. Exactly one retry — hammering a rate-limited endpoint is how
 * the rate limit got earned in the first place.
 */
const KV_GET_RETRY_BACKOFF_MS = 200;

/** Upstash REST envelope shared by every command response. */
interface KvRestResponse {
  result?: unknown;
  error?: string;
  ok?: boolean;
}

/**
 * REEA-996 — the outcome of a checked KV read: `get()` collapses "unreachable"
 * and "key missing" into one null, which callers then misread as honest no-data.
 * getChecked keeps the two apart so a failed read can never masquerade as an
 * empty store.
 */
export interface KvGetOutcome {
  /** false = the store could not be reached (timeout, non-OK, network error,
   *  or an Upstash error envelope). No statement about the key is possible. */
  reachable: boolean;
  /** Raw string value when reachable and present; null when reachable but
   *  the key is missing (or the value is not a string). */
  value: string | null;
}

export interface SharedKv {
  /** Value for the key, or null when missing/unreachable. */
  get(key: string): Promise<string | null>;
  /** Store the value with a TTL (seconds). Resolves true on ack. */
  set(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  /**
   * REEA-827 — atomic increment, creating the key with a TTL when absent.
   * Returns the post-increment count, or null when unsupported/unreachable
   * (callers then degrade to their local layer). Optional so existing
   * test fakes that only need get/set keep compiling.
   */
  incr?(key: string, ttlSeconds: number): Promise<number | null>;
  /**
   * REEA-996 — a get() that reports reachability separately from the value.
   * Optional so existing test fakes that only need get/set keep compiling;
   * callers that must distinguish "store failed" from "store empty" (the
   * weekly metrics read) use it when present.
   */
  getChecked?(key: string): Promise<KvGetOutcome>;
}

let cached: SharedKv | null | undefined;

/** Resolve the KV binding from env; null when no shared store is configured. */
export function getSharedKv(): SharedKv | null {
  if (cached !== undefined) return cached;
  const base = (process.env.KV_REST_API_URL ?? "").replace(/\/+$/, "");
  const token = process.env.KV_REST_API_TOKEN ?? "";
  cached = base && token ? makeKv(base, token) : null;
  return cached;
}

function makeKv(base: string, token: string): SharedKv {
  // Upstash-style REST bases may carry an auth/query suffix on the root URL;
  // assemble via URL parts so command paths always land on the pathname and
  // any query survives. (Authorization header is also sent — Upstash accepts
  // either.)
  const root = new URL(base);
  const pathPrefix = root.pathname.replace(/\/+$/, "");
  const buildUrl = (commandPath: string) =>
    `${root.origin}${pathPrefix}/${commandPath}${root.search}`;

  async function request(
    commandPath: string,
    init: { method?: string; body?: string } = {},
  ): Promise<KvRestResponse | null> {
    try {
      const res = await fetch(buildUrl(commandPath), {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(init.body !== undefined ? { "Content-Type": "text/plain" } : {}),
        },
        body: init.body,
        signal: AbortSignal.timeout(KV_TIMEOUT_MS),
        cache: "no-store",
      });
      if (!res.ok) return null;
      return (await res.json()) as KvRestResponse;
    } catch {
      return null; // KV unreachable — caller degrades to the local cache
    }
  }

  /**
   * REEA-143: some Upstash-shaped REST bases fold the trailing SET args
   * (`EX` / `PX` + ttl) into the stored value instead of parsing them as
   * options, so a raw GET comes back as `<value>\nEX\n<ttl>`. Normalize so
   * callers parse exactly what set() wrote. JSON snapshots otherwise fail
   * JSON.parse on the trailing tail, which is what made cross-instance polls
   * miss jobs that were present in the shared store.
   */
  function stripTtlEcho(value: string): string {
    return value.replace(/\r?\n(?:EX|PX)\n\d+$/, "");
  }

  return {
    async get(key) {
      const data = await request(`get/${encodeURIComponent(key)}`);
      if (!data || data.ok === false) return null;
      return typeof data.result === "string" ? stripTtlEcho(data.result) : null;
    },
    // REEA-996 — same wire call as get(), but the failure modes stay
    // distinguishable: unreachable (no answer / error envelope) vs a
    // reachable missing key (result null). One backoff retry rides here so
    // a transient blip is absorbed before the caller degrades at all.
    async getChecked(key): Promise<KvGetOutcome> {
      const attempt = async (): Promise<KvGetOutcome> => {
        const data = await request(`get/${encodeURIComponent(key)}`);
        if (data === null || data.error !== undefined || data.ok === false) {
          return { reachable: false, value: null };
        }
        return {
          reachable: true,
          value: typeof data.result === "string" ? stripTtlEcho(data.result) : null,
        };
      };
      const first = await attempt();
      if (first.reachable) return first;
      await new Promise((resolve) => setTimeout(resolve, KV_GET_RETRY_BACKOFF_MS));
      return attempt();
    },
    async set(key, value, ttlSeconds) {
      // Upstash REST: remaining SET arguments continue in the request body,
      // one per line — `<value>`, then `EX <ttl>`. Compact JSON.stringify
      // output never contains raw newlines, so the line split is safe.
      const body = `${value}\nEX\n${Math.max(1, Math.ceil(ttlSeconds))}`;
      const data = await request(`set/${encodeURIComponent(key)}`, {
        method: "POST",
        body,
      });
      return data !== null && data.ok !== false;
    },
    // REEA-827 — INCR is atomic server-side, so concurrent instances sharing
    // the store each land a distinct count (a GET/SET read-modify-write would
    // lose increments under concurrent instances — the exact per-instance
    // blindness this counter exists to fix). The TTL is armed on the first
    // hit of a window key; the window id is encoded in the key itself, so a
    // missed EXPIRE only leaks a stale key, never a wrong count.
    async incr(key, ttlSeconds) {
      const data = await request(`incr/${encodeURIComponent(key)}`);
      if (!data || data.ok === false || typeof data.result !== "number") return null;
      if (data.result === 1) {
        await request(`expire/${encodeURIComponent(key)}/${Math.max(1, Math.ceil(ttlSeconds))}`);
      }
      return data.result;
    },
  };
}
