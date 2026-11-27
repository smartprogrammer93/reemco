// @vitest-environment jsdom
/**
 * REEA-1266 — the results renderer stamps the provisional-shell marker.
 *
 * The /api/health funnel walk tells a capacity-deferred (or
 * finalized-at-budget) document apart from a genuinely broken funnel by
 * reading `data-collection-pending="1"` off the served shell
 * (lib/collect/shell-markers.ts). This pin renders the SAME component the
 * server streams and proves the marker is actually stamped for a provisional
 * snapshot and absent for a settled one — so the probe's "still working"
 * branch cannot silently become dead code if the renderer changes.
 *
 * The fixtures replay the live pending-shell shape: zero products, one
 * "live check deferred — the server is at its collection cap" note per lane
 * (renderBusySnapshot), `settled: false`.
 */
import { cleanup, render } from "@testing-library/react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires the act environment flag for `act()` in a non-default
// harness (same pattern as the other jsdom component pins in this repo).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const searchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
  usePathname: () => "/results",
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
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

import ResultsClient from "@/components/ResultsClient";
import { resetCountryPrefs } from "@/lib/country";
import { resetLocalePrefs } from "@/lib/i18n";
import { resetStockPrefs } from "@/lib/stock";
import type { LiveSearchResult } from "@/lib/collect/live-search";
import {
  COLLECTION_PENDING_ATTR,
  COLLECTION_PENDING_VALUE,
} from "@/lib/collect/shell-markers";

const MARKER = `[${COLLECTION_PENDING_ATTR}="${COLLECTION_PENDING_VALUE}"]`;

/** The honest pending shell the admission gate serves when it cannot admit. */
const DEFERRED_AT_CAP: LiveSearchResult = {
  products: [],
  notes: [
    { merchant: "Xcite", hits: 0, error: "live check deferred — the server is at its collection cap" },
    { merchant: "Jarir", hits: 0, error: "live check deferred — the server is at its collection cap" },
  ],
  settled: false,
};

/** A settled document that genuinely answered with nothing. */
const SETTLED_ZERO: LiveSearchResult = {
  products: [],
  notes: [{ merchant: "Xcite", hits: 0 }],
  settled: true,
};

beforeEach(() => {
  searchParams.set("q", "sony");
  resetStockPrefs();
  resetCountryPrefs();
  resetLocalePrefs();
  vi.stubGlobal("navigator", {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
    sendBeacon: () => true,
  });
  // The page's follow-up feed: nothing richer to fold in.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("null", { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderResults(snap: LiveSearchResult) {
  return render(
    <ResultsClient
      query="sony"
      page={1}
      country="KW"
      showOutOfStock={false}
      locale="en"
      stages={[Promise.resolve(snap)]}
    />,
  );
}

describe("REEA-1266 — provisional-shell marker on the served results document", () => {
  it("a deferred-at-cap shell carries the marker (the health probe's 'still working' signal)", async () => {
    await act(async () => {
      renderResults(DEFERRED_AT_CAP);
    });
    const flag = document.querySelector(MARKER);
    expect(flag).not.toBeNull();
    // Invisible metadata: `hidden` keeps it out of layout and the a11y tree.
    expect(flag?.hasAttribute("hidden")).toBe(true);
    expect((flag?.textContent ?? "")).toBe("");
  });

  it("a settled zero document carries NO marker (so the probe still answers 503)", async () => {
    await act(async () => {
      renderResults(SETTLED_ZERO);
    });
    expect(document.querySelector(MARKER)).toBeNull();
  });
});
