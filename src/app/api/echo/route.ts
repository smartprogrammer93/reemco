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
 *    reporting the answered status and elapsed time. REEA-408 adds the
 *    second half of the hop chain to the report: when the rotation ends on
 *    the block-page shape, the probe also runs the jsdom clearance tier the
 *    live collectors fall through to and reports its answered bytes
 *    (`clearedBytes`), so a silent zero classifies as rotation-only-vs-
 *    clearance miss from the deployed path without another deploy.
 *  - `www.sultan-center.com`: the Sultan Center mobile search POST with the
 *    Arabic fixed-set query, reporting the answered `items` count — the
 *    silent-zero cell on this merchant completes WITHOUT an error note, so
 *    only the deployed runtime can say whether the hop itself answers empty
 *    from this egress or the rows lose the shared coverage gate.
 *
 * Same read-only shape as /api/health (REEA-314): deterministic JSON, no
 * cookies, no persisted state, every upstream call best-effort with its own
 * bounded window so the answer always lands inside one request.
 */
import { fetchThroughChallenge, VERIFIED_BOT_HEADERS } from "@/lib/collect/search-fallback";
import { jsdClearedHtml } from "@/lib/collect/live-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const HEADER_ECHO_URL = "https://httpbin.org/get";
const IP_ECHO_URL = "https://api.ipify.org?format=json";
const ECHO_WINDOW_MS = 6_000;
// Mirrors the live hop windows: the handshake gets 2x LIVE_SEARCH_TIMEOUT_MS.
const ZONE_WINDOW_MS = 8_000;
const LULU_URL = "https://www.luluhypermarket.com/en/search?query=basmati+rice";
const PCK_URL = "https://pckuwait.com/wp-json/wc/store/v1/products?search=dell&per_page=24";

interface ZoneProbe {
  status: number | 0;
  ms: number;
  bytes?: number;
  items?: number;
  clearedBytes?: number;
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

/**
 * REEA-408 — behind a failed rotation, report what the jsdom clearance tier
 * reads with the SAME url the collector would ask: bytes > 0 means the
 * collector's second half answers on this egress and the standing note
 * comes from somewhere else; bytes 0 means the clearance tier itself misses
 * here (missing jsdom on the runtime, or the zone holds the block through
 * the JSD script) and the zero is honest.
 */
async function withClearanceTier(fetchImpl: typeof fetch, probe: ZoneProbe, url: string): Promise<ZoneProbe> {
  if (probe.status === 200) return probe;
  const clearedBytes = await jsdClearedHtml(fetchImpl, url)
    .then((text) => text.length)
    .catch(() => 0);
  return { ...probe, clearedBytes };
}

async function probeSultan(fetchImpl: typeof fetch): Promise<ZoneProbe> {
  // Exactly the collector hop shape (POST, store-scoped payload, JSON-in /
  // JSON-out) with the Arabic fixed-set query — the cell where this zone
  // demonstrably carries stock.
  const started = Date.now();
  try {
    const res = await fetchImpl("https://www.sultan-center.com/mobile/api/search", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        customerId: "",
        delivery_type: "home_delivery",
        currentpage: 1,
        filters: [],
        sortType: "position",
        currency: "KD",
        version: "eyJ2ZXJzaW9uX25hbWUiOiI3LjciLCJwbGF0Zm9ybSI6IklvcCJ9",
        substoreId: "45",
        store: 1,
        sortOrder: "asc",
        search_data: "أرز بسمتي",
        pagesize: 24,
        area: "",
        uid: null,
        deviceId: "reemco-web",
        is_web: 1,
        store_type: "ecom",
        latitude: "",
        longitude: "",
        isDesktop: "Desktop",
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(ZONE_WINDOW_MS),
    });
    const parsed = (await res.json()) as { products?: { product_list?: unknown[] } };
    return { status: res.status, ms: Date.now() - started, items: parsed?.products?.product_list?.length ?? 0 };
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

  const [echo, fallbackIp, luluRaw, pckRaw, sultan] = await Promise.all([
    hopEcho,
    ipOnly,
    probeZone(fetch, LULU_URL, {}),
    probeZone(fetch, PCK_URL, { accept: "application/json" }),
    probeSultan(fetch),
  ]);
  const [lulu, pckuwait] = await Promise.all([
    withClearanceTier(fetch, luluRaw, LULU_URL),
    withClearanceTier(fetch, pckRaw, PCK_URL),
  ]);

  return Response.json({
    hop: echo.headers,
    originIp: echo.originIp || fallbackIp,
    echoError: echo.error,
    zones: {
      "www.luluhypermarket.com": lulu,
      "pckuwait.com": pckuwait,
      "www.sultan-center.com": sultan,
    },
    identity: VERIFIED_BOT_HEADERS["user-agent"],
    checkedAt: new Date().toISOString(),
  });
}
