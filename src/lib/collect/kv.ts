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
  async function request(
    path: string,
    init: { method?: string; body?: string } = {},
  ): Promise<KvRestResponse | null> {
    try {
      const res = await fetch(`${base}/${path}`, {
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

  return {
    async get(key) {
      const data = await request(`get/${encodeURIComponent(key)}`);
      if (!data || data.ok === false) return null;
      return typeof data.result === "string" ? data.result : null;
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
