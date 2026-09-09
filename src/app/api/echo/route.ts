/**
 * REEA-394 — outbound-identity echo debug endpoint.
 *
 * GET /api/echo answers, from INSIDE the deployed runtime, exactly what
 * identity outbound retailer hops present:
 *  - `hop`: the verified-crawler header set the shared handshake leads with
 *    (VERIFIED_BOT_HEADERS), observed by a public header echo service — i.e.
 *    what any remote zone actually sees, including platform-added headers.
 *  - `originIp`: the shared-egress source IP a remote peer records (needed as
 *    an allow-list value when a zone challenges on IP reputation).
 *  - `zones`: both challenging zones' real hop endpoints probed through the
 *    same fetchThroughChallenge handshake the adapters ride, with the exact
 *    hop shape each one uses (accept-json extra for the Store API hop),
 *    reporting the answered status and elapsed time.
 *
 * Same read-only shape as /api/health (REEA-314): deterministic JSON, no
 * cookies, no persisted state, every upstream call best-effort with its own
 * bounded window so the answer always lands inside one request.
 */
import { fetchThroughChallenge, VERIFIED_BOT_HEADERS } from "@/lib/collect/search-fallback";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const HEADER_ECHO_URL = "https://httpbin.org/get";
const IP_ECHO_URL = "https://api.ipify.org?format=json";
const ECHO_WINDOW_MS = 6_000;
// Mirrors the live hop windows: the handshake gets 2x LIVE_SEARCH_TIMEOUT_MS.
const ZONE_WINDOW_MS = 8_000;

interface ZoneProbe {
  status: number | 0;
  ms: number;
  bytes?: number;
  error?: string;
}

async function probeZone(
  fetchImpl: typeof fetch,
  url: string,
  extraHeaders: Record<string, string>,
): Promise<ZoneProbe> {
  const started = Date.now();
  try {
    // Exactly the hop shape: handshake identity leads, caller extras ride on top.
    const res = await fetchThroughChallenge(fetchImpl, url, { headers: extraHeaders }, AbortSignal.timeout(ZONE_WINDOW_MS));
    const body = await res.text();
    return { status: res.status, ms: Date.now() - started, bytes: body.length };
  } catch (err) {
    return { status: 0, ms: Date.now() - started, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function GET(): Promise<Response> {
  // The hop identity rides verbatim to the echo services, so what they report
  // IS what the retailer zones see from this runtime (headers + source IP).
  const hopEcho: Promise<{ headers: Record<string, string>; originIp: string; error?: string }> = fetch(HEADER_ECHO_URL, {
    headers: VERIFIED_BOT_HEADERS,
    cache: "no-store",
    signal: AbortSignal.timeout(ECHO_WINDOW_MS),
  })
    .then(async (res) => {
      const parsed = (await res.json()) as { headers?: Record<string, string>; origin?: string };
      return { headers: parsed.headers ?? {}, originIp: parsed.origin ?? "" };
    })
    .catch((err: unknown) => ({ headers: {}, originIp: "", error: err instanceof Error ? err.message : String(err) }));
  // Fallback origin probe in case the header echo service itself is down.
  const ipOnly = fetch(IP_ECHO_URL, { cache: "no-store", signal: AbortSignal.timeout(ECHO_WINDOW_MS) })
    .then(async (res) => ((await res.json()) as { ip?: string }).ip ?? "")
    .catch(() => "");

  const [echo, fallbackIp, lulu, pckuwait] = await Promise.all([
    hopEcho,
    ipOnly,
    probeZone(fetch, "https://www.luluhypermarket.com/en/search?query=basmati+rice", {}),
    probeZone(fetch, "https://pckuwait.com/wp-json/wc/store/v1/products?search=dell&per_page=24", {
      accept: "application/json",
    }),
  ]);

  return Response.json({
    hop: echo.headers,
    originIp: echo.originIp || fallbackIp,
    echoError: echo.error,
    zones: {
      "www.luluhypermarket.com": lulu,
      "pckuwait.com": pckuwait,
    },
    identity: VERIFIED_BOT_HEADERS["user-agent"],
    checkedAt: new Date().toISOString(),
  });
}
