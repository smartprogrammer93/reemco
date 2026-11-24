// @vitest-environment jsdom
/**
 * REEA-1141 — duplicate result cards: the streamed shelf must paint exactly
 * ONE card per productId.
 *
 * Live defect (deployed stamp eba496ca, probe 21:22Z): panadol rendered 4
 * products as 8 cards. A cached stale-while-revalidate replay ("Checked
 * 3 min ago") was painted by the lead flush, and because the per-flush diff
 * baselined only the ADJACENT prior snapshot, an empty intermediate flush
 * reset that baseline — so the next live flush ("Checked just now") re-painted
 * every product the replay had already painted. Same productId, merchant and
 * price, twice, with two different ages.
 *
 * The fix has two halves, both pinned here at the SERVED-DOCUMENT level (the
 * surface QA samples):
 *  1. a replay lead (`snap.replay`) contributes no cards — the live stage
 *     paints the newest collectedAt version of the same products (AC-3), so
 *     the stale shelf is REPLACED, not appended beside the fresh one;
 *  2. the painted-id baseline is CUMULATIVE across every earlier flush, so an
 *     empty intermediate flush can never reset it.
 * The smallest proving check: async-SSR the exact stage chain and count the
 * `<article>` cards vs the unique productIds the payload carries.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToReadableStream } from "react-dom/server";
import ResultsClient from "@/components/ResultsClient";
import type { LiveSearchResult } from "@/lib/collect/live-search";
import type { NormalizedProduct } from "@/types/product";

// Same Next-app-router stubs the sibling ResultsClient suite uses: the async
// SSR path only needs useRouter/useSearchParams/usePathname to be mountable.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/results",
  useRouter: () => ({ refresh: () => {}, replace: () => {} }),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: { href: string; children: React.ReactNode; [k: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const REPLAY_STAMP = "2026-11-23T23:22:22.000Z"; // 5 min before the live run
const LIVE_STAMP = "2026-11-23T23:27:22.000Z";
// Server render clock baked into the streamed props (REEA-283): the replay
// card would read "Updated 5 minutes ago", the live card "Just now".
const RENDER_START = Date.parse("2026-11-23T23:27:22.400Z");

function panadol(id: string, title: string, stamp: string, merchant: string, price: number): NormalizedProduct {
  return {
    productId: id,
    title,
    brand: "Panadol",
    offers: [
      {
        merchant,
        price,
        currency: "KWD",
        url: `https://${merchant.toLowerCase().replace(/\s+/g, "")}.example/${id}`,
        inStock: true,
        collectedAt: stamp,
      },
    ],
    coupons: [],
    variations: [],
    alternatives: [],
    scrapedAt: stamp,
  };
}

const A = "panadol-pain-relief-tablets-24tablets";
const B = "panadol-advance-tablets-1pack";

/** Two distinct live products (query-matching titles → confident/primary). */
function shelf(stamp: string, merchant = "Xcite"): NormalizedProduct[] {
  return [
    panadol(A, "Panadol Pain Relief Tablets 24Tablets", stamp, merchant, 5.8),
    panadol(B, "Panadol Advance Tablets 1Pack", stamp, merchant, 6.05),
  ];
}

function snap(
  products: NormalizedProduct[],
  extra: Partial<LiveSearchResult> = {},
): LiveSearchResult {
  return {
    products,
    notes: [{ merchant: "Xcite", hits: products.length }],
    suggestions: products,
    settled: true,
    ...extra,
  };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  let html = "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    html += decoder.decode(value, { stream: true });
  }
  return html;
}

async function servedDocument(stages: Promise<LiveSearchResult>[]): Promise<string> {
  const stream = await renderToReadableStream(
    <ResultsClient
      query="panadol"
      page={1}
      country={null}
      showOutOfStock={false}
      locale="en"
      renderStartMs={RENDER_START}
      stages={stages}
    />,
  );
  return drain(stream);
}

function articleTitles(html: string): string[] {
  const articles = html.match(/<article[\s\S]*?<\/article>/g) ?? [];
  return articles.map((a) => {
    const title = a.match(/rc-card-title[^>]*>([\s\S]*?)<\/[^>]+>/);
    return (title?.[1] ?? "").replace(/<[^>]+>/g, "").trim();
  });
}

describe("REEA-1141 — one card per productId in the served streamed document", () => {
  it("does not paint the stale replay shelf beside the live shelf (panadol repro)", async () => {
    // The exact live shape: cached replay lead, an empty intermediate flush
    // (an adapter that answered with no kept offers), then the live shelf.
    const stages = [
      Promise.resolve(snap(shelf(REPLAY_STAMP), { replay: true, settled: false })),
      Promise.resolve(snap([], { settled: false })),
      Promise.resolve(snap(shelf(LIVE_STAMP))),
    ];
    const html = await servedDocument(stages);
    const titles = articleTitles(html);
    // Pre-fix: 4 cards (2 stale + 2 fresh). Post-fix: the replay is replaced
    // by the live shelf, so 2 cards, each title exactly once.
    expect(titles).toHaveLength(2);
    expect(titles.filter((t) => t.includes("Pain Relief"))).toHaveLength(1);
    expect(titles.filter((t) => t.includes("Advance"))).toHaveLength(1);
    // AC-3: the surviving card carries the NEWEST collectedAt, not the stale
    // one. The replay's 5-minute age must not appear in the served document.
    expect(html).toContain("Updated just now");
    expect(html).not.toContain("Updated 5 minutes ago");
  });

  it("keeps the cumulative painted baseline across an empty intermediate flush", async () => {
    // Cold-run sibling of the same class: an empty flush between two identical
    // cumulative snapshots used to reset the adjacent baseline, re-painting
    // every already-painted card.
    const stages = [
      Promise.resolve(snap(shelf(LIVE_STAMP))),
      Promise.resolve(snap([], { settled: false })),
      Promise.resolve(snap(shelf(LIVE_STAMP))),
    ];
    const titles = articleTitles(await servedDocument(stages));
    expect(titles).toHaveLength(2);
    expect(new Set(titles).size).toBe(2);
  });

  it("still paints genuinely new products arriving in a later flush", async () => {
    const later = [
      ...shelf(LIVE_STAMP),
      panadol("panadol-extra-pain-relief-tablets-24tablets", "Panadol Extra Pain Relief Tablets 24tablets", LIVE_STAMP, "Blink", 8),
    ];
    const stages = [
      Promise.resolve(snap(shelf(LIVE_STAMP))),
      Promise.resolve(snap(later)),
    ];
    const titles = articleTitles(await servedDocument(stages));
    // The two already-painted products keep their slots; the third paints once.
    expect(titles).toHaveLength(3);
    expect(titles.filter((t) => t.includes("Extra Pain Relief"))).toHaveLength(1);
  });

  it("paints a replay lead normally when no live fan-out supersedes it (fresh memo hit)", async () => {
    // A fresh memo hit is a single stage and is the honest current answer —
    // no live run behind it, so it must paint.
    const stages = [Promise.resolve(snap(shelf(LIVE_STAMP)))];
    const titles = articleTitles(await servedDocument(stages));
    expect(titles).toHaveLength(2);
  });
});
