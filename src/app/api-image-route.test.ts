/**
 * REEA-1128 — same-origin retailer image proxy.
 *
 * Pins the REEA-1118 guardrail ("no console errors on the results page"): the
 * route answers 200 in EVERY case — the image when the upstream resolves, a
 * neutral category glyph when it does not — so a shopper's browser can never
 * render a broken-image icon or log `Failed to load resource: 403`.
 *
 * Also pins the two behaviours that make the cold miss survivable: the
 * measured 403 is retried, and a resolved image is cached in-process so a
 * burst of cards (or the next shopper) does not re-pay the upstream hop.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/image/route";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

function request(raw?: string): NextRequest {
  const qs = raw === undefined ? "" : `?u=${encodeURIComponent(raw)}`;
  return new NextRequest(`https://ns539626.ip-144-217-72.net/api/image${qs}`);
}

function imageResponse(bytes: Uint8Array = PNG_BYTES, type = "image/png"): Response {
  // A fresh ArrayBuffer is a valid BodyInit under the DOM lib typing (a plain
  // Uint8Array<ArrayBufferLike> is not).
  const body = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(body).set(bytes);
  return new Response(body, { status: 200, headers: { "content-type": type } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("REEA-1128 — a resolved upstream image is served from our origin", () => {
  it("returns the bytes with an image content-type and a long-lived cache", async () => {
    const fetchMock = vi.fn(async () => imageResponse());
    vi.stubGlobal("fetch", fetchMock);
    const url = "https://cdn.shopify.com/s/files/1/0999/0001/files/served-once.png?v=1";
    const res = await GET(request(url));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toContain("immutable");
    // A real photo is not a miss: ProxyRetryImage must not re-request it.
    expect(res.headers.get("x-reea-image")).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG_BYTES);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The browser identity the retailer CDN expects, never a bare fetch default.
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(String(init.headers && (init.headers as Record<string, string>)["user-agent"])).toContain(
      "Mozilla/5.0",
    );
  });

  it("serves a cached image without a second upstream hop (burst de-dupe)", async () => {
    const fetchMock = vi.fn(async () => imageResponse(PNG_BYTES, "image/jpeg"));
    vi.stubGlobal("fetch", fetchMock);
    const url = "https://cdn.shopify.com/s/files/1/0999/0002/files/cached.webp?v=2";
    const first = await GET(request(url));
    expect(first.status).toBe(200);
    const second = await GET(request(url));
    expect(second.status).toBe(200);
    expect(second.headers.get("content-type")).toBe("image/jpeg");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("REEA-1128 — the measured cold-miss 403 is retried, then degrades to 200", () => {
  it("retries a 403 and serves the image once the upstream warms", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("nope", { status: 403 }))
      .mockResolvedValueOnce(new Response("nope", { status: 403 }))
      .mockResolvedValueOnce(imageResponse(PNG_BYTES, "image/jpeg"));
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(request("https://cdn.shopify.com/s/files/1/0999/0003/files/cold.jpg?v=3"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("a permanent 403 answers 200 with the neutral glyph — never a broken image", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(request("https://cdn.shopify.com/s/files/1/0999/0004/files/dead.jpg?v=4"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    // Short TTL: the next page load retries instead of pinning the miss.
    expect(res.headers.get("cache-control")).toContain("max-age=30");
    // ProxyRetryImage's miss contract: a 1x1-intrinsic SVG is the only signal
    // an <img> can read (it cannot see the content-type or the header).
    expect(res.headers.get("x-reea-image")).toBe("miss");
    const body = await res.text();
    expect(body).toContain("<svg");
    expect(body).toContain('width="1"');
    expect(body).toContain('height="1"');
  });

  it("a network throw is retried and degrades to the glyph, still 200", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(request("https://cdn.shopify.com/s/files/1/0999/0005/files/reset.jpg?v=5"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
  });
});

describe("REEA-1128 — bad input never reaches the shopper as a console error", () => {
  it("a missing `u` answers the glyph without fetching", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a private-host `u` is refused without fetching (SSRF guard)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(request("https://127.0.0.1/secret.png"));
    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an upstream answer that is not an image is a miss, not a mislabelled body", async () => {
    const fetchMock = vi.fn(async () => new Response("<html>blocked</html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await GET(request("https://cdn.shopify.com/s/files/1/0999/0006/files/html.jpg?v=6"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
  });
});
