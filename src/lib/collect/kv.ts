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

/** Upstash REST envelope shared by every command response. */
interface KvRestResponse {
  result?: unknown;
  error?: string;
  ok?: boolean;
}

export interface SharedKv {
  /** Value for the key, or null when missing/unreachable. */
  get(key: string): Promise<string | null>;
  /** Store the value with a TTL (seconds). Resolves true on ack. */
  set(key: string, value: string, ttlSeconds: number): Promise<boolean>;
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
  };
}
