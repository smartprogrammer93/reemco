/**
 * REEA-376 — shared bounded body read for every live-fetch path.
 *
 * Every retailer hop runs inside a tight per-query budget, and one fat
 * upstream document (a broken edge shell, an interstitial with inlined
 * assets, an unpaginated JSON envelope) must not force the whole response
 * into memory before the caller learns it is too big. readBodyCapped walks
 * the body chunk-by-chunk: under the cap the text comes back complete; over
 * the cap the remaining stream is cancelled and an error note is thrown
 * instead of handing back a fully-buffered string. Callers keep their
 * existing catch paths — the thrown note rides each hop as a per-hop
 * failure, so one oversized answer still degrades one retailer, never the
 * whole results page.
 *
 * Applied in scraper.fetchWithTimeout, search-fallback.fetchResponse,
 * live-search.fetchChecked, and the api/health funnel hop (get/readHop).
 */

/** ~4 MB — above every measured live document (the home shell lands around
 *  0.5 MB; the health funnel hops stop at their first flush; the batch-five
 *  Woo archive envelopes on the PC Kuwait lane ride past the old 2 MB line),
 *  far below the multi-megabyte tails of broken edge shells and inlined-asset
 *  pages. REEA-602. */
export const MAX_RESPONSE_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Stream the response body into a string, bounded at `maxBytes`. An optional
 * `until` predicate short-circuits the read as soon as the accumulated text
 * satisfies it (the health funnel's shell-first hop): the rest of the stream
 * is cancelled and only the accumulated prefix comes back. Overflow aborts
 * with an error note — never a full-string return.
 */
export async function readBodyCapped(
  res: Response,
  maxBytes: number = MAX_RESPONSE_BODY_BYTES,
  until?: (text: string) => boolean,
): Promise<string> {
  const body = res.body;
  if (!body) {
    // Non-streaming Response (minimal test doubles, odd runtimes): the text
    // is already materialized, so enforce the cap on it after the fact and
    // still take the bounded error path on overflow. Length in UTF-16 units
    // slightly under-counts multi-byte payloads; good enough for a fallback.
    const text = await res.text();
    if (text.length > maxBytes) throw bodyCapError(maxBytes);
    return text;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      // Past the cap — drop the tail instead of holding the whole document.
      await reader.cancel().catch(() => {});
      throw bodyCapError(maxBytes);
    }
    text += decoder.decode(value, { stream: true });
    if (until?.(text)) {
      // First flush carried everything the caller waits for — stop reading.
      await reader.cancel().catch(() => {});
      break;
    }
  }
  text += decoder.decode();
  return text;
}

/**
 * Consume `res` through readBodyCapped and hand the caller a Response-shaped
 * view over the buffered text (ok/status/statusText/headers and friends are
 * kept by reference from the original). Used by the helpers that must return
 * a Response (fetchChecked, fetchResponse): every body read then rides the
 * capped path, while the callers' `res.json()` / `res.text()` shape stays
 * unchanged. Non-OK answers pass through untouched — their callers throw on
 * the status without ever touching the body.
 */
export async function readCappedResponse(
  res: Response,
  maxBytes: number = MAX_RESPONSE_BODY_BYTES,
): Promise<Response> {
  if (!res.ok) return res;
  const text = await readBodyCapped(res, maxBytes);
  const view: Partial<Response> = {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
    url: res.url,
    redirected: res.redirected,
    type: res.type,
    bodyUsed: true,
    body: null,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
    clone: () => view as Response,
  };
  return view as Response;
}

function bodyCapError(maxBytes: number): Error {
  return new Error(`response body exceeds the ${maxBytes}-byte cap`);
}
