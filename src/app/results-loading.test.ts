/**
 * REEA-437 / REEA-448 G2 — results loading boundary locale resolution.
 *
 * Next renders loading.tsx WITHOUT the page's `searchParams` prop, so the
 * boundary must resolve its flash locale from request-time reads alone and
 * never throw on the missing prop (the deployed 500 class this covers). The
 * query-text link of the chain rides the `next-url` header when present and
 * drops silently when it is not.
 */
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface HeadersLike {
  get(key: string): string | null;
}

let nextUrlValue: string | null = null;
let headersThrows = false;

vi.mock("next/headers", () => ({
  headers: async (): Promise<HeadersLike> => {
    if (headersThrows) throw new Error("prerender/static host");
    return {
      get: (key: string) => (key.toLowerCase() === "next-url" ? nextUrlValue : null),
    };
  },
  cookies: async () => ({ get: () => undefined }),
}));

import ResultsLoading from "./results/loading";

async function stamp(html: string): Promise<string> {
  const match = html.match(/meta-stamp[^>]*>([^<]+)</);
  return match ? match[1] : "";
}

async function renderFlash(): Promise<string> {
  return renderToString(await ResultsLoading());
}

beforeEach(() => {
  nextUrlValue = null;
  headersThrows = false;
});

describe("ResultsLoading flash locale (REA-437 / REEA-448 G2)", () => {
  it("renders the English stamp with no header hint and does not throw", async () => {
    const html = await renderFlash();
    expect(await stamp(html)).toBe("Checking live stores…");
    expect(html).toContain("skeleton-card");
  });

  it("takes the Arabic flash stamp from the next-url query hint", async () => {
    nextUrlValue = "/results?q=%D8%A2%D9%8A%D9%81%D9%88%D9%86";
    const html = await renderFlash();
    expect(await stamp(html)).toBe("جارٍ التحقق من المتاجر…");
  });

  it("falls back silently when request-time header reads are unavailable", async () => {
    headersThrows = true;
    const html = await renderFlash();
    expect(await stamp(html)).toBe("Checking live stores…");
  });
});
