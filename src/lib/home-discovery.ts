/**
 * REEA-1070 AC1/AC2/AC7/AC10 — the server-side data contract behind the
 * Direction A "Shelf" home discovery modules.
 *
 * Everything here is a PURE projection of snapshots a live per-query fan-out
 * just produced. There is no bundled catalogue, no hand-written product list
 * and no static price: a module item only exists because an adapter answered
 * this run. Empty / no-response / partial states are explicit so the UI can
 * render the calm lines instead of inventing merchandise.
 *
 * This module stays dependency-light (coverage.ts + product types + savings
 * arithmetic) so the client shell can import the types and copy without
 * pulling the server-only collection machinery into the browser bundle. The
 * live runner lives in lib/collect/home-discovery.ts.
 */
import {
  COVERAGE_ORDER,
  summarizeResponders,
  type LiveSearchResult,
  type ResponderSummary,
} from "@/lib/collect/coverage";
import { savingsFor, type OfferSavings } from "@/lib/savings";
// REEA-1268 — the browse module links to the fixed category surfaces, so the
// homepage's "Browse categories" module is navigation, not a search list.
import {
  CATEGORY_SURFACES,
  categoryHref,
  categoryMatchesTitle,
} from "@/lib/categories";

export type HomeModuleStatus = "loading" | "live" | "empty" | "no-response";

export type HomeModuleReason =
  | "no-queries"
  | "no-live-offers"
  | "no-price-drops"
  | "no-categories"
  | "all-retailers-failed";

/** Per-query responder truth the calm inline status names both groups from. */
export interface HomeQueryTruth {
  query: string;
  responders: ResponderSummary;
  offers: number;
  coupons: number;
  /** False when the snapshot finalized at the completion budget. */
  settled: boolean;
  collectedAt?: string;
  collectedAtEpochMs?: number;
}

export interface HomeRetailer {
  merchant: string;
  /** "live" = answered with ≥1 offer on this load; "no-response" = failed
   *  every queried round; "empty" = answered but kept zero offers. */
  state: "live" | "no-response" | "empty";
  offers: number;
  answeredQueries: number;
  noResponseQueries: number;
}

export interface HomePriceDrop {
  productId: string;
  title: string;
  image?: string;
  merchant: string;
  currentPrice: number;
  currency: string;
  /** Named baseline (struck − current ±0.01) for the drop line. */
  savings: OfferSavings;
  checkedAt?: string;
  checkedAtEpochMs?: number;
  href: string;
}

export interface HomeCategory {
  id: string;
  label: { en: string; ar: string };
  /** Live category query the entry links to (a fresh per-query collection). */
  query: string;
  /** Number of live-collected products in this category on this load. */
  count: number;
  href: string;
}

export interface HomeModule<T> {
  status: HomeModuleStatus;
  items: T[];
  reason?: HomeModuleReason;
  /** True when at least one query finalized before every adapter settled. */
  partial: boolean;
}

export interface HomeMethodBand {
  status: HomeModuleStatus;
  offers: number;
  coupons: number;
  retailersAnswered: number;
  retailersQueried: number;
  queries: number;
  /** Affiliate-neutrality disclosure, both locales, from the shared table. */
  disclosure: { en: string; ar: string };
  provenance: {
    collectedAt?: string;
    collectedAtEpochMs?: number;
    queries: string[];
  };
}

export interface HomeDiscovery {
  status: HomeModuleStatus;
  partial: boolean;
  collectedAt?: string;
  collectedAtEpochMs?: number;
  queries: HomeQueryTruth[];
  retailerStrip: HomeModule<HomeRetailer>;
  priceDrops: HomeModule<HomePriceDrop>;
  categories: HomeModule<HomeCategory>;
  methodBand: HomeMethodBand;
}

/** One live snapshot (or a null when its run could not answer at all). */
export interface HomeDiscoverySnapshot {
  query: string;
  snap: LiveSearchResult | null;
}

/**
 * REEA-1268 — the homepage "Browse categories" module is now the fixed
 * browse taxonomy, not a list of searches: every entry links to a live
 * `/c/<slug>` surface (see lib/categories.ts). The count is still this
 * load's own live match count; a category the home fan-out did not touch
 * reads 0 rather than a fabricated figure.
 */
/** Product title → the first browse category it belongs to, or null. */
export function categoryOfTitle(title: string): string | null {
  for (const def of CATEGORY_SURFACES) {
    if (categoryMatchesTitle(title, def)) return def.slug;
  }
  return null;
}

function productHref(productId: string): string {
  return `/product/${encodeURIComponent(productId)}`;
}

function coverageRank(merchant: string): number {
  const i = COVERAGE_ORDER.indexOf(merchant as (typeof COVERAGE_ORDER)[number]);
  return i < 0 ? COVERAGE_ORDER.length : i;
}

function newestStamp(snapshots: readonly HomeDiscoverySnapshot[]): {
  collectedAt?: string;
  collectedAtEpochMs?: number;
} {
  let best: number | null = null;
  let iso: string | undefined;
  for (const { snap } of snapshots) {
    if (!snap) continue;
    const epoch = snap.collectedAtEpochMs ?? Date.parse(snap.collectedAt ?? "");
    if (!Number.isFinite(epoch)) continue;
    if (best == null || epoch > best) {
      best = epoch;
      iso = snap.collectedAt ?? new Date(epoch).toISOString();
    }
  }
  return best == null ? {} : { collectedAt: iso, collectedAtEpochMs: best };
}

function isPartial(snapshots: readonly HomeDiscoverySnapshot[]): boolean {
  return snapshots.some(({ snap }) => !snap || snap.settled === false);
}

/**
 * Aggregate the retailer strip from the run's own responder notes. A merchant
 * that answered any queried round reads "live"; a merchant that failed every
 * round reads "no-response"; an answer with zero offers reads "empty". Fixed
 * adapter order keeps consecutive loads identical.
 */
function buildRetailerStrip(
  snapshots: readonly HomeDiscoverySnapshot[],
  partial: boolean,
): HomeModule<HomeRetailer> {
  const rows = new Map<
    string,
    { offers: number; answeredQueries: number; noResponseQueries: number; emptyQueries: number }
  >();
  const touch = (merchant: string) => {
    let row = rows.get(merchant);
    if (!row) {
      row = { offers: 0, answeredQueries: 0, noResponseQueries: 0, emptyQueries: 0 };
      rows.set(merchant, row);
    }
    return row;
  };
  for (const { snap } of snapshots) {
    if (!snap) continue;
    const responders = snap.responders ?? summarizeResponders(snap.notes);
    for (const merchant of responders.queried) {
      const row = touch(merchant);
      const note = snap.notes.find((n) => n.merchant === merchant);
      row.offers += note?.hits ?? 0;
      if (responders.answered.includes(merchant)) row.answeredQueries += 1;
      else if (responders.noResponse.includes(merchant)) row.noResponseQueries += 1;
      else if (responders.answeredEmpty.includes(merchant)) row.emptyQueries += 1;
    }
  }
  const items = [...rows.entries()]
    .map(([merchant, row]) => ({
      merchant,
      state:
        row.answeredQueries > 0
          ? ("live" as const)
          : row.noResponseQueries > 0
            ? ("no-response" as const)
            : ("empty" as const),
      offers: row.offers,
      answeredQueries: row.answeredQueries,
      noResponseQueries: row.noResponseQueries,
    }))
    .sort(
      (a, b) => coverageRank(a.merchant) - coverageRank(b.merchant) || a.merchant.localeCompare(b.merchant),
    );
  if (items.length === 0) {
    return { status: "no-response", items: [], reason: "no-queries", partial };
  }
  if (!items.some((r) => r.state === "live")) {
    const allFailed = items.every((r) => r.state === "no-response");
    return {
      status: allFailed ? "no-response" : "empty",
      items,
      reason: allFailed ? "all-retailers-failed" : "no-live-offers",
      partial,
    };
  }
  return { status: "live", items, partial };
}

/**
 * Price drops: only offers whose own listing carried a compare-at price above
 * the current price, with the named baseline the design requires. One card per
 * product (the biggest live drop wins), capped at three.
 */
function buildPriceDrops(
  snapshots: readonly HomeDiscoverySnapshot[],
  partial: boolean,
): HomeModule<HomePriceDrop> {
  if (snapshots.length === 0 || snapshots.every(({ snap }) => !snap)) {
    return { status: "no-response", items: [], reason: "no-queries", partial };
  }
  let offersSeen = 0;
  const bestByProduct = new Map<string, HomePriceDrop>();
  for (const { snap } of snapshots) {
    if (!snap) continue;
    for (const product of snap.products) {
      offersSeen += product.offers.length;
      for (const offer of product.offers) {
        const savings =
          offer.savings ??
          savingsFor({
            merchant: offer.merchant,
            price: offer.price,
            currency: offer.currency,
            url: offer.url,
            wasPrice: offer.wasPrice,
            collectedAt: offer.collectedAt,
          });
        if (!savings) continue;
        const candidate: HomePriceDrop = {
          productId: product.productId,
          title: product.title,
          ...(product.image ? { image: product.image } : {}),
          merchant: offer.merchant,
          currentPrice: offer.price,
          currency: offer.currency,
          savings,
          ...(offer.collectedAt ? { checkedAt: offer.collectedAt } : {}),
          ...(offer.collectedAtEpochMs != null
            ? { checkedAtEpochMs: offer.collectedAtEpochMs }
            : {}),
          href: productHref(product.productId),
        };
        const current = bestByProduct.get(product.productId);
        if (
          !current ||
          candidate.savings.amount > current.savings.amount ||
          (candidate.savings.amount === current.savings.amount &&
            (candidate.checkedAtEpochMs ?? 0) > (current.checkedAtEpochMs ?? 0))
        ) {
          bestByProduct.set(product.productId, candidate);
        }
      }
    }
  }
  const items = [...bestByProduct.values()]
    .sort(
      (a, b) =>
        b.savings.amount - a.savings.amount ||
        (b.checkedAtEpochMs ?? 0) - (a.checkedAtEpochMs ?? 0) ||
        a.title.localeCompare(b.title),
    )
    .slice(0, 3);
  if (offersSeen === 0) {
    return { status: "empty", items: [], reason: "no-live-offers", partial };
  }
  if (items.length === 0) {
    return { status: "empty", items: [], reason: "no-price-drops", partial };
  }
  return { status: "live", items, partial };
}

function buildCategories(
  snapshots: readonly HomeDiscoverySnapshot[],
  partial: boolean,
): HomeModule<HomeCategory> {
  // REEA-1268 D-2 — the module is the fixed eight-surface browse taxonomy.
  // Every item is a navigation entry to a live `/c/<slug>` shelf, whether or
  // not this home fan-out happened to touch that category: the category page
  // runs its own live collection. The count is this load's own matched-product
  // count, so a 0 is honest rather than a static claim.
  let productsSeen = 0;
  const counts = new Map<string, number>();
  for (const { snap } of snapshots) {
    if (!snap) continue;
    for (const product of snap.products) {
      productsSeen += 1;
      for (const def of CATEGORY_SURFACES) {
        if (categoryMatchesTitle(product.title, def)) {
          counts.set(def.slug, (counts.get(def.slug) ?? 0) + 1);
        }
      }
    }
  }
  const items: HomeCategory[] = CATEGORY_SURFACES.map((def) => ({
    id: def.slug,
    label: def.label,
    query: def.queries[0],
    count: counts.get(def.slug) ?? 0,
    href: categoryHref(def.slug),
  }));
  if (snapshots.length === 0 || snapshots.every(({ snap }) => !snap)) {
    return { status: "no-response", items, reason: "no-queries", partial };
  }
  if (productsSeen === 0) {
    return { status: "empty", items, reason: "no-live-offers", partial };
  }
  if (!items.some((item) => item.count > 0)) {
    return { status: "empty", items, reason: "no-categories", partial };
  }
  return { status: "live", items, partial };
}

/**
 * Build the whole discovery payload from the run's live snapshots. Pure: the
 * same snapshot set always yields the same modules (fixed ordering, no clock
 * read beyond the snapshots' own stamps).
 */
export function buildHomeDiscovery(
  snapshots: readonly HomeDiscoverySnapshot[],
  disclosure: { en: string; ar: string },
): HomeDiscovery {
  const partial = isPartial(snapshots);
  const stamp = newestStamp(snapshots);
  const queries: HomeQueryTruth[] = snapshots.map(({ query, snap }) => {
    if (!snap) {
      return {
        query,
        responders: { queried: [], answered: [], answeredEmpty: [], noResponse: [] },
        offers: 0,
        coupons: 0,
        settled: false,
      };
    }
    const responders = snap.responders ?? summarizeResponders(snap.notes);
    const offers = snap.products.reduce((n, p) => n + p.offers.length, 0);
    const coupons = snap.notes.reduce((n, note) => n + (note.coupons ?? 0), 0);
    return {
      query,
      responders,
      offers,
      coupons,
      settled: snap.settled !== false,
      ...(snap.collectedAt ? { collectedAt: snap.collectedAt } : {}),
      ...(snap.collectedAtEpochMs != null
        ? { collectedAtEpochMs: snap.collectedAtEpochMs }
        : {}),
    };
  });
  const totalOffers = queries.reduce((n, q) => n + q.offers, 0);
  const answered = new Set<string>();
  const queried = new Set<string>();
  for (const q of queries) {
    for (const m of q.responders.answered) answered.add(m);
    for (const m of q.responders.queried) queried.add(m);
  }
  const retailerStrip = buildRetailerStrip(snapshots, partial);
  const priceDrops = buildPriceDrops(snapshots, partial);
  const categories = buildCategories(snapshots, partial);
  const allNull = snapshots.every(({ snap }) => !snap);
  const status: HomeModuleStatus =
    snapshots.length === 0 || allNull
      ? "no-response"
      : totalOffers === 0
        ? "empty"
        : "live";
  return {
    status,
    partial,
    ...stamp,
    queries,
    retailerStrip,
    priceDrops,
    categories,
    methodBand: {
      status: snapshots.length === 0 || allNull ? "no-response" : "live",
      offers: totalOffers,
      coupons: queries.reduce((n, q) => n + q.coupons, 0),
      retailersAnswered: answered.size,
      retailersQueried: queried.size,
      queries: queries.length,
      disclosure,
      provenance: {
        ...stamp,
        queries: snapshots.map(({ query }) => query),
      },
    },
  };
}

/* ---- Copy for the calm states (server-owned; the UI may render these). ---- */

export interface HomeDiscoveryCopy {
  retailerStripTitle: string;
  priceDropsTitle: string;
  categoriesTitle: string;
  methodTitle: string;
  liveLabel: string;
  noResponseLabel: string;
  emptyRetailer: string;
  emptyPriceDrops: string;
  emptyCategories: string;
  noResponseModule: string;
  methodOffers: string;
  methodCoupons: string;
  methodRetailers: string;
  methodProvenance: string;
  disclosure: string;
  liveNote: string;
}

export const HOME_DISCOVERY_COPY: Record<"en" | "ar", HomeDiscoveryCopy> = {
  en: {
    retailerStripTitle: "Retailers checked live",
    priceDropsTitle: "Price drops right now",
    categoriesTitle: "Browse categories",
    methodTitle: "How we compare",
    liveLabel: "live",
    noResponseLabel: "no response",
    emptyRetailer: "No retailer answered this load — try again.",
    emptyPriceDrops: "No price drops in the last hour.",
    emptyCategories: "No live categories matched this load.",
    noResponseModule: "We couldn't reach the retailers — no cached snapshot is shown.",
    methodOffers: "live offers compared",
    methodCoupons: "coupons applied",
    methodRetailers: "retailers answered",
    methodProvenance: "Collected live just now",
    disclosure:
      "Reemco earns affiliate commissions from some retailer links. This never affects the ranking you see — best effective price always wins.",
    liveNote: "live",
  },
  ar: {
    retailerStripTitle: "متاجر تم فحصها مباشرة",
    priceDropsTitle: "انخفاضات الأسعار الآن",
    categoriesTitle: "تصفح الفئات",
    methodTitle: "كيف نقارن",
    liveLabel: "مباشر",
    noResponseLabel: "لا يوجد رد",
    emptyRetailer: "لم يجب أي متجر في هذه الجولة — حاول مرة أخرى.",
    emptyPriceDrops: "لا توجد انخفاضات أسعار خلال الساعة الماضية.",
    emptyCategories: "لا توجد فئات مباشرة في هذه الجولة.",
    noResponseModule: "تعذّر الوصول إلى المتاجر — لا تُعرض نسخة مخزَّنة.",
    methodOffers: "عروض مباشرة تمت مقارنتها",
    methodCoupons: "كوبونات مطبَّقة",
    methodRetailers: "متاجر أجابت",
    methodProvenance: "جُمعت مباشرة الآن",
    disclosure:
      "تحصل ريمكو على عمولات تابعة من بعض روابط المتاجر. هذا لا يؤثر أبدًا على الترتيب الذي تراه — أفضل سعر فعلي يفوز دائمًا.",
    liveNote: "مباشر",
  },
};

/** The loading state the UI may render while the live modules are in flight. */
export const HOME_DISCOVERY_LOADING_STATUS: HomeModuleStatus = "loading";
