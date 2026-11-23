// @vitest-environment jsdom
/**
 * REEA-1091 — product-page hydration parity + offer-row CTA spacing.
 *
 * Found live on fc383a8: the streamed offer card recomputed "Checked Ns ago"
 * from Date.now() during the hydration render (React #418 text mismatch), and
 * the CTA anchor's inline-flex layout dropped the authored whitespace, so the
 * label painted "Checked4s ago·Xcite" instead of "Checked 4s ago · Xcite".
 *
 * The clock cases pin the REE A-283 discipline (one baked renderStartMs, never
 * a render-time clock read) on the SERVER render (renderToStaticMarkup — no
 * effects, exactly the HTML that gets hydrated) and the structure case pins the
 * spacing fix: the label must ship as ONE child of the anchor (normal inline
 * flow inside), not as separate flex items that lose the spaces.
 */
import { Suspense, act } from "react";
import { cleanup, render } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OfferCard from "@/components/OfferCard";
import ProductHero from "@/components/ProductHero";
import { PulseOfferCascade } from "@/components/CollectionPulse";
import { resetSessionCacheForTests } from "@/lib/collect/useCollection";
import { checkedAgeLabel } from "@/lib/i18n";
import type { CollectJob } from "@/lib/collect/types";
import type { NormalizedProduct } from "@/types/product";

// React 19 act() support for the async `use(firstStage)` render below.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

beforeEach(() => resetSessionCacheForTests());
afterEach(() => {
  cleanup();
  resetSessionCacheForTests();
});

const COLLECTED = "2026-09-05T21:00:00Z";
const COLLECTED_MS = Date.parse(COLLECTED);

const offer = {
  merchant: "Xcite",
  priceLabel: "KD 99.00",
  inStock: true,
  collectedAt: COLLECTED,
  method: "live" as const,
  isBest: false,
  savings: null,
  url: "https://www.xcite.com/p",
};

describe("REEA-1091 — offer-row CTA derives its age from the baked render clock", () => {
  it("the served HTML uses renderStartMs, not Date.now(), for the CTA age", () => {
    // 120s baked age → the REEA-1100 localized ladder renders "2 min ago".
    const html = renderToStaticMarkup(<OfferCard {...offer} renderStartMs={COLLECTED_MS + 120_000} />);
    expect(html).toContain(
      '<span class="offer-cta-label">Checked <span class="tabular">2 min ago</span> · <bdi>Xcite</bdi></span>',
    );
  });

  it("a repeated server pass with the same baked clock reproduces identical HTML", () => {
    const props = { ...offer, renderStartMs: COLLECTED_MS + 180_000 };
    const first = renderToStaticMarkup(<OfferCard {...props} />);
    const second = renderToStaticMarkup(<OfferCard {...props} />);
    expect(second).toBe(first);
    expect(first).toContain("3 min ago");
  });

  it("clamps an offer collected after the render clock to 'just now' (never a negative age)", () => {
    const html = renderToStaticMarkup(
      <OfferCard
        {...offer}
        collectedAt={new Date(COLLECTED_MS + 500).toISOString()}
        renderStartMs={COLLECTED_MS}
      />,
    );
    expect(html).toContain('<span class="tabular">just now</span>');
  });
});

describe("REEA-1091 — offer-row CTA spacing survives the button's flex layout", () => {
  it("ships the label as ONE flex item so the authored spaces are real text", () => {
    const { container } = render(<OfferCard {...offer} renderStartMs={COLLECTED_MS + 120_000} />);
    const anchor = container.querySelector("a");
    expect(anchor).not.toBeNull();
    // One direct child (the inline-flow label), not "Checked" + age + "·" +
    // merchant as separate flex items — that split is what dropped the spaces.
    expect(anchor?.children).toHaveLength(1);
    expect(anchor?.firstElementChild?.className).toBe("offer-cta-label");
    // The label carries the spaces around the age and the separator (the live
    // ticker may have advanced the digit after mount — the spaces must not).
    expect(anchor?.textContent).toMatch(/^Checked .+ · Xcite$/);
  });

  it("the served HTML carries the spaces around the age and the separator", () => {
    const html = renderToStaticMarkup(<OfferCard {...offer} renderStartMs={COLLECTED_MS + 120_000} />);
    // textContent-style check on the anchor: the space text nodes survive.
    expect(html).toContain(
      '<span class="offer-cta-label">Checked <span class="tabular">2 min ago</span> · <bdi>Xcite</bdi></span>',
    );
  });

  it("keeps the fallback label unwrapped when there is no usable stamp", () => {
    const { container } = render(
      <OfferCard {...offer} collectedAt="not-a-date" renderStartMs={COLLECTED_MS} />,
    );
    // No age → the plain label, and no empty .offer-cta-label wrapper.
    expect(container.querySelector(".offer-cta-label")).toBeNull();
    expect(container.querySelector("a")?.textContent).toBe("View at Xcite");
  });
});

describe("REEA-1091 — cascade threads the baked clock into offer cards", () => {
  it("the cascade's CTA uses the product page's renderStartMs", () => {
    const html = renderToStaticMarkup(
      <PulseOfferCascade
        offers={[
          {
            merchant: "Xcite",
            domain: "xcite.com",
            price: 99,
            currency: "KWD",
            url: "https://xcite.com/p",
            inStock: true,
            collectedAt: COLLECTED,
            method: "live",
          },
        ]}
        renderStartMs={COLLECTED_MS + 120_000}
      />,
    );
    expect(html).toContain("2 min ago");
  });
});

describe("REEA-1091 — freshness chip derives its figure from the baked clock", () => {
  it("renders the relative age from renderStartMs, not render time", () => {
    const { container } = render(
      <OfferCard {...offer} renderStartMs={COLLECTED_MS + 3 * 60_000} />,
    );
    expect(container.querySelector(".fresh-chip")?.textContent?.replace(/\s+/g, " ")).toContain(
      "updated 3m ago · Xcite · live",
    );
  });
});

/* ---- /product's real component: ProductHero ---------------------------- */

function product(): NormalizedProduct {
  return {
    productId: "reea1091-probe",
    title: "Apple iPhone 16 6.1-inch 128GB Black.",
    brand: "Apple",
    offers: [],
    coupons: [],
    variations: [],
    alternatives: [],
  };
}

function job(collectedAt: string): CollectJob {
  return {
    jobId: "job-reea1091",
    productId: "reea1091-probe",
    status: "complete",
    mode: "live",
    startedAt: collectedAt,
    finishedAt: collectedAt,
    subtasks: [{ retailer: "Xcite", domain: "xcite.com", status: "done", offersFound: 1 }],
    offers: [
      {
        merchant: "Xcite",
        domain: "xcite.com",
        price: 249.9,
        currency: "KWD",
        url: "https://www.xcite.com/apple-iphone-16-128gb-black/p",
        inStock: true,
        collectedAt,
        collectedAtEpochMs: Date.parse(collectedAt),
        method: "live",
      },
    ],
  };
}

async function renderHero(renderStartMs?: number) {
  cleanup();
  resetSessionCacheForTests();
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <ProductHero
          product={product()}
          locale="en"
          firstStage={Promise.resolve(job(COLLECTED))}
          renderStartMs={renderStartMs}
        />
      </Suspense>,
    );
  });
  return {
    checked: Array.from(document.querySelectorAll(".rc-checked")).map((e) => e.textContent),
    note: Array.from(document.querySelectorAll(".rc-product-meta")).map((e) => e.textContent),
  };
}

describe("REEA-1091 — ProductHero derives every age from the baked clock", () => {
  it("renders the offer-row age from renderStartMs, not render time", async () => {
    const baked = await renderHero(COLLECTED_MS + 120_000);
    expect(baked.checked.length).toBeGreaterThan(0);
    // 120s baked → "Checked 2m ago" (the REEA-1096 checkedAgeLabel ladder).
    expect(baked.checked[0]).toBe(checkedAgeLabel("en", 120));
    expect(baked.note.join(" ")).toContain("2 min ago");
  });

  it("without a baked clock the same render reads the mount-time clock instead", async () => {
    // The mount clock is today, months after COLLECTED — proving the baked
    // path above did not silently read Date.now().
    const live = await renderHero(undefined);
    expect(live.checked[0]).not.toBe(checkedAgeLabel("en", 120));
    expect(live.checked[0]).toMatch(/Checked \d+[dh] ago|Checked \d+m ago/);
  });
});

/** Hydrate the exact served HTML with a clock that has moved on — the live
 *  failure shape (SSR at 0s, hydration seconds later). React reports a text
 *  mismatch to console.error and rethrows it out of hydrateRoot; the baked
 *  clock must leave neither. */
async function hydrateServedCard(props: Parameters<typeof OfferCard>[0]) {
  const host = document.createElement("div");
  host.innerHTML = renderToString(<OfferCard {...props} />);
  document.body.appendChild(host);
  const errors: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args.map(String).join(" "));
  });
  const realNow = Date.now;
  // The browser clock is 1000s past the collection when hydration runs.
  Date.now = () => COLLECTED_MS + 1_000_000;
  let root: ReturnType<typeof hydrateRoot> | undefined;
  try {
    await act(async () => {
      root = hydrateRoot(host, <OfferCard {...props} />, {
        // The sanctioned hook for hydration mismatches: React reports the
        // text mismatch here instead of throwing it out of the test.
        onRecoverableError: (err) => {
          errors.push(err instanceof Error ? err.message : String(err));
        },
      });
    });
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  try {
    await act(async () => {
      root?.unmount();
    });
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  Date.now = realNow;
  spy.mockRestore();
  document.body.removeChild(host);
  return errors.filter((e) => /hydrat|did not match|418/i.test(e));
}

describe("REEA-1091 — hydration parity for the served offer card", () => {
  it("a baked renderStartMs hydrates with no text mismatch", async () => {
    const errors = await hydrateServedCard({ ...offer, renderStartMs: COLLECTED_MS + 120_000 });
    expect(errors).toEqual([]);
  });

  it("control: without a baked clock the same hydration DOES mismatch", async () => {
    // Proves the harness can see the defect the fix removes (the pre-fix card
    // recomputed Date.now() during hydration).
    const errors = await hydrateServedCard({ ...offer });
    expect(errors.length).toBeGreaterThan(0);
  });
});
