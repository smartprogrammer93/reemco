import type { NormalizedProduct } from "@/types/product";
import {
  curatedBrandInTitle,
  isAccessoryTitle,
  narrowDeviceLead,
  titleHasDeviceIntent,
} from "@/lib/relevance";

/**
 * REEA-437 — pure helpers shared by the LIVE collect chain (live-search.ts)
 * and the client-rendered results shell (ResultsClient.tsx). Everything here
 * must stay dependency-light: ResultsClient imports this module, so whatever
 * it pulls lands in the BROWSER bundle. live-search.ts keeps the server-only
 * machinery (node:zlib, the jsdom-backed clearance hop, the retailer
 * adapters) out of that graph; this file holds only the snapshot shape and
 * the plain-text coverage sentence. Behavior is unchanged from when both
 * lived in live-search.ts — the split is purely about graph weight.
 */

/**
 * REEA-1070 AC2 — the structured partial-response truth for one query: which
 * retailers answered, which did not, and which answered but kept no offer.
 * Derived only from the run's own live notes (never a static registry), in the
 * fixed adapter order so repeated renders read identically.
 */
export interface ResponderSummary {
  /** Every retailer this fan-out queried, in fixed adapter order. */
  queried: string[];
  /** Retailers whose adapter answered with ≥1 kept offer. */
  answered: string[];
  /** Retailers that answered successfully but kept zero offers. */
  answeredEmpty: string[];
  /** Retailers that errored, timed out, or missed the completion budget. */
  noResponse: string[];
}

export interface LiveSearchResult {
  products: NormalizedProduct[];
  /** Per-retailer notes for the diagnostics panel; failures included.
   *  REEA-488 item 2: `coupons` counts that merchant's kept offers carrying
   *  coupon info among `hits` — coupon coverage per stage, so under-delivery
   *  by a specific adapter is measurable instead of guessed. */
  notes: { merchant: string; hits: number; coupons?: number; error?: string }[];
  /**
   * REEA-1070 AC2 — structured responder truth for this query, stamped by
   * the live snapshot builder from the same notes the page renders. The calm
   * inline status can name both groups without re-deriving them from prose.
   */
  responders?: ResponderSummary;
  /**
   * REEA-1070 AC10 — ISO + epoch collection moment of this snapshot. The UI
   * humanises the epoch against its own clock in EN/AR; the ISO stays for
   * traceability and absolute stamps.
   */
  collectedAt?: string;
  collectedAtEpochMs?: number;
  /** Empty-match suggestion set (REEA-114); every snapshot carries its own. */
  suggestions?: NormalizedProduct[];
  /**
   * REEA-437 — the query forms the converged run actually issued (whole query
   * first, then the trimmed-token widening), present once the widened retry
   * ran. The empty state names them so a zero answer says what was tried
   * instead of just declaring the shelf empty.
   */
  attemptedQueries?: string[];
  /**
   * REEA-437 — false ONLY on finalized-at-budget snapshots: the completion
   * budget closed the stream while hops were still in flight, so a zero count
   * on such a snapshot is provisional (the late offers converge behind the
   * response and fold in through the follow-up feed). The heading renders its
   * skeleton for these instead of flashing "0 results" at the shopper.
   * Absent/undefined means the snapshot is the honest settled answer.
   */
  settled?: boolean;
  /**
   * REEA-793 B1 — true ONLY on snapshots whose query carries device intent
   * (brand+model shape) while ZERO device-family rows rendered and at least
   * one accessory row did: the completion budget closed before the device
   * offer landed, so the page shows the labeled pending row under the count
   * line instead of letting an accessory impersonate the Best-price slot.
   * Absent/undefined = not pending (normal pass, byte-for-byte markup).
   */
  deviceLeadPending?: boolean;
  /**
   * REEA-793 B2 — true when the rendered set carries ZERO offers from the
   * Kuwait-primary retailers (Xcite, Jarir, Eureka, Sultan Center) while
   * fallback (non-Kuwait) offers did render: the Kuwait-primary hops missed
   * the completion budget, so the page states it honestly instead of
   * silently degrading to an Egypt-only listing. Derived purely from the
   * already-rendered offer state — no extra fetch, no bundled registry.
   * REEA-835 — the flag is a property of the RENDERED SET, not of the query
   * shape: the device-intent gate stays on `deviceLeadPending` only, so a
   * first paint on ANY query can tell "no Kuwait answer yet" (and the lead
   * card can withhold the unqualified Best-price flag while the Kuwait batch
   * is still in flight).
   */
  kuwaitPendingStatus?: boolean;
}

/* Fixed presentation order for the coverage sentence — mirrors the COLLECTORS
   declaration order in live-search.ts (REEA-254 determinism: the same settled
   set reads as the same sentence on consecutive loads, whatever the completion
   order was). Kept as a plain name list so this module stays importable from
   the browser bundle; a parity test in live-search.test.ts pins it to the
   adapter list. Unknown merchants rank last, exactly like adapterRank did. */
export const COVERAGE_ORDER = [
  "Xcite",
  "Blink",
  "Eureka",
  "Sultan Center",
  "Jarir",
  "Amazon.eg",
  "Quadra Stores",
  "Next Store",
  // REEA-901 — "PC Kuwait" retired from the live rotation (deployed-egress
  // HTTP 403 on every hop shape, 36/36 adapter failures W37); the parity pin
  // keeps this list == COLLECTORS order, so the retired name leaves with its
  // collector.
  "Lulu Hypermarket",
  "Switch",
  "Wibi",
  "Astore",
  "Zayoom",
  "Yousifi",
  "Aster Pharmacy",
  "Nahdi",
  // REEA-1067 — "Ounass" retired from the live rotation (0 hits on every
  // sample from the self-hosted egress; restore path in live-search.ts). The
  // parity pin keeps this list == COLLECTORS order, so the retired name leaves
  // with its collector.
  "Danube Home",
  // REEA-557 first wave — appended in COLLECTORS declaration order so the
  // parity pin in live-search.test.ts keeps COVERAGE_ORDER == adapter order.
  "Alghanim Electronics",
  "BinSina",
  // REEA-723 batch tail — Nest first (per-locale Shopify SSR search), then
  // the ladder lanes in ranking order, appended in COLLECTORS declaration
  // order so the parity pin keeps COVERAGE_ORDER == adapter order.
  "Nest",
  "Bomai",
  "Hobby Center",
  "YasO",
] as const;

function coverageRank(merchant: string): number {
  const i = COVERAGE_ORDER.indexOf(merchant as (typeof COVERAGE_ORDER)[number]);
  return i < 0 ? COVERAGE_ORDER.length : i;
}

/**
 * REEA-1070 AC2 — structured responder truth from the run's own live notes.
 * Pure and deterministic: fixed adapter order, no clock, no fetch. An adapter
 * note carrying an error is a non-responder; a note with zero kept offers is
 * "answered empty"; a note with offers is an answer. The calm inline status
 * can therefore name both groups from one object instead of parsing prose.
 */
export function summarizeResponders(
  notes: LiveSearchResult["notes"],
): ResponderSummary {
  const ordered = [...notes].sort(
    (a, b) => coverageRank(a.merchant) - coverageRank(b.merchant),
  );
  const queried: string[] = [];
  const answered: string[] = [];
  const answeredEmpty: string[] = [];
  const noResponse: string[] = [];
  for (const n of ordered) {
    queried.push(n.merchant);
    if (n.error) noResponse.push(n.merchant);
    else if (n.hits > 0) answered.push(n.merchant);
    else answeredEmpty.push(n.merchant);
  }
  return { queried, answered, answeredEmpty, noResponse };
}

/**
 * REEA-290 + REEA-574 R1 — the per-query coverage sentence the results page
 * states in plain text, straight from the run's own notes (no second fetch,
 * no bundled registry — a note is only ever written by the live fan-out that
 * produced the offers on screen). Names follow the fixed adapter order above.
 *
 * R1 truth rules:
 *  - contributors ("Prices from …" / "أسعار من …") list ONLY retailers with
 *    ≥1 rendered offer row at final paint — pass the same filtered product set
 *    the grid renders (`rendered`), so a country / out-of-stock toggle that
 *    drops a merchant's last row drops its name from the sentence too;
 *  - nonResponders ("No response from …" / "لا يوجد رد من …") keep the old
 *    semantics: notes carrying an error (errored or timed-out adapters);
 *  - an adapter that answered successfully with zero rendered offers appears
 *    in NEITHER list;
 *  - an empty contributor set hides the contributor sentence entirely — an
 *    empty-result page keeps only the empty state (R3), never a phantom
 *    merchant list above zero rows. Without a rendered set (notes-only
 *    diagnostic callers) `hits` is the row count to filter on.
 *
 * REEA-1078 AC9 adds a third, separate sentence: a lane the reachability
 * record says is blocked from this egress is named as UNREACHABLE, never left
 * to read as "no offers". It is excluded from the "No response" half so one
 * lane gets one statement, and it is the one sentence that still renders on a
 * zero-row page — because that is exactly where a silent zero lies loudest.
 */
export function coverageLine(
  notes: LiveSearchResult["notes"],
  locale?: "en" | "ar",
  rendered?: readonly NormalizedProduct[],
  /**
   * REEA-1078 AC9 — merchants whose zone the reachability record says is
   * blocked from this egress right now. Empty/absent = the pre-AC9 sentence,
   * byte for byte.
   */
  unreachable?: readonly string[],
): string {
  const ordered = [...notes].sort(
    (a, b) => coverageRank(a.merchant) - coverageRank(b.merchant),
  );
  const ar = locale === "ar";
  const unreachableSet = new Set(unreachable ?? []);
  const failed: string[] = [];
  const answered: string[] = [];
  // REEA-1078 AC9 — the blocked set is derived FIRST so the zero-row branch
  // below can still speak: a blocked lane is the reason the shelf is empty,
  // and "0 results" with no explanation is exactly the defect this AC names.
  // A lane whose offers rendered (or, notes-only, that answered with rows)
  // disproves the record and keeps today's sentence untouched.
  const seen = new Set<string>();
  if (rendered) {
    for (const p of rendered) for (const o of p.offers) seen.add(o.merchant);
  }
  const blocked: string[] = [];
  for (const n of ordered) {
    if (!unreachableSet.has(n.merchant)) continue;
    if (seen.has(n.merchant)) continue;
    if (!rendered && n.hits > 0 && !n.error) continue;
    blocked.push(n.merchant);
  }
  // AC9 — shopper copy only: no status code, no adapter internals.
  const blockedText =
    blocked.length > 0
      ? ar
        ? `تعذّر الوصول إلى ${joinNames(blocked, ar)}.`
        : `Unreachable: ${joinNames(blocked)}.`
      : "";
  if (rendered) {
    // REEA-574 rev 1 (R1): zero rendered rows → nothing to vouch for, and the
    // error half would still phantom a merchant above an empty page — hide
    // the whole sentence, not just the contributor half. AC9 exception: a
    // blocked lane is named, because it explains the empty shelf.
    if (rendered.length === 0) return blockedText;
    // Contributor set from the rows actually on screen, in fixed adapter order.
    answered.push(
      ...[...seen].sort((a, b) => coverageRank(a) - coverageRank(b)),
    );
    // A merchant whose offers rendered DID answer — never also a gap.
    for (const n of ordered) {
      if (n.error && !seen.has(n.merchant)) failed.push(n.merchant);
    }
  } else {
    // Notes-only fallback (server diagnostics): kept-hits count is the row count.
    for (const n of ordered) {
      if (n.error) failed.push(n.merchant);
      else if (n.hits > 0) answered.push(n.merchant); // success-but-empty: unnamed
    }
  }
  // A lane spoken for as UNREACHABLE is not ALSO reported as "no response":
  // one honest statement per lane.
  for (let i = failed.length - 1; i >= 0; i--) {
    if (unreachableSet.has(failed[i])) failed.splice(i, 1);
  }
  // REEA-279: the sentence shapes live in the static table so the stamp
  // matches the shell language; EN keeps the exact figures it had before.
  const parts: string[] = [];
  if (blockedText) parts.push(blockedText);
  if (ar) {
    // REEA-1069 — the signed AR/RTL checklist names this sentence verbatim:
    // "الأسعار من … . لم تستجب … هذه المرة." Responders first, then the
    // non-responders, both with isolated Latin retailer names.
    if (answered.length > 0) parts.push(`الأسعار من ${summarizeNames(answered, ar)}.`);
    if (failed.length > 0) parts.push(`لم تستجب ${summarizeNames(failed, ar)} هذه المرة.`);
    return parts.join(" ");
  }
  if (failed.length > 0)
    // REEA-468 G3 (PM copy decision): short-form scans faster at the grid
    // slot — "No response from X" pairs with the coupon badge as its
    // counterpart, instead of the longer sentence.
    parts.push(`No response from ${summarizeNames(failed)}.`);
  if (answered.length > 0)
    parts.push(`Prices from ${summarizeNames(answered)}.`);
  return parts.join(" ");
}

/** Plain-text name list: "Xcite" / "Xcite and Blink" / "Xcite, Blink and Eureka". */
function joinNames(names: string[], ar = false): string {
  if (names.length <= 1) return names.join("");
  // REEA-1069 / signed AR checklist A5: the Arabic sentence joins every name
  // with " و" (no Latin commas), matching the designed
  // "الأسعار من Xcite وEureka وWibi." verbatim. English keeps its list comma.
  if (ar) return names.join(" و");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * REEA-1069 — the Direction A partial-response status must stay ONE calm
 * inline line at 375. The live rotation now has ~20 adapters, so listing every
 * name produced an 8-line band above the first price. Name up to three
 * responders / three non-responders and summarise the rest ("and N more" /
 * "وN أخرى"): still honest about who answered and who did not, still a single
 * neutral container, no invented names.
 */
function summarizeNames(names: string[], ar = false, max = 3): string {
  if (names.length <= max) return joinNames(names, ar);
  const shown = names.slice(0, max);
  const rest = names.length - max;
  return `${shown.join(ar ? " و" : ", ")}${ar ? ` و${rest} أخرى` : ` and ${rest} more`}`;
}

/** REEA-488 item 2 — per-merchant coupon coverage rolled up over the notes
 *  of many snapshots (one weekly export). Merchants sum across snapshots in
 *  the fixed adapter order; `coverage` is couponOffers/offers, null when the
 *  merchant kept no offers at all in the window. */
export interface MerchantCouponCoverage {
  merchant: string;
  offers: number;
  couponOffers: number;
  coverage: number | null;
}

export function aggregateCouponCoverage(
  noteSets: Iterable<LiveSearchResult["notes"]>,
): MerchantCouponCoverage[] {
  const totals = new Map<string, { offers: number; couponOffers: number }>();
  for (const notes of noteSets) {
    for (const n of notes) {
      const t = totals.get(n.merchant) ?? { offers: 0, couponOffers: 0 };
      t.offers += n.hits;
      t.couponOffers += n.coupons ?? 0;
      totals.set(n.merchant, t);
    }
  }
  return [...totals.entries()]
    .sort((a, b) => coverageRank(a[0]) - coverageRank(b[0]))
    .map(([merchant, t]) => ({
      merchant,
      offers: t.offers,
      couponOffers: t.couponOffers,
      coverage: t.offers > 0 ? t.couponOffers / t.offers : null,
    }));
}

/** REEA-488 metrics — alternatives fill rate over served products: one entry
 *  per snapshot's product list, counted as simple weekly numbers (AC: the
 *  non-empty rate on the top queries). */
export interface AlternativesFill {
  productsSeen: number;
  productsWithAlternatives: number;
  nonEmptyRate: number | null;
}

export function aggregateAlternativesFill(
  productSets: Iterable<NormalizedProduct[]>,
): AlternativesFill {
  let seen = 0;
  let filled = 0;
  for (const products of productSets) {
    for (const p of products) {
      seen += 1;
      if (p.alternatives.length > 0) filled += 1;
    }
  }
  return { productsSeen: seen, productsWithAlternatives: filled, nonEmptyRate: seen > 0 ? filled / seen : null };
}

/* REEA-793 — B1 device-first lead + B2 Kuwait coverage honesty. Pure helpers
   shared by the serve-time guard (live-search.ts) and the results shell
   (ResultsClient.tsx); same dependency-light contract as the rest of this
   module (relevance.ts is pure string logic, browser-safe). */

/** The four Kuwait-primary retailers the coverage status speaks for
 *  (REEA-793 B2). Fixed list, mirrors the COVERAGE_ORDER head — a plain name
 *  list, no registry, so a merchant is counted only when its OWN live offers
 *  actually rendered. */
export const KUWAIT_PRIMARY_MERCHANTS: readonly string[] = [
  "Xcite",
  "Jarir",
  "Eureka",
  "Sultan Center",
];

/** REEA-793 B1 — does the QUERY itself carry device intent (brand+model
 *  shape)? Same predicates the client tier gate and the ranker use, applied
 *  to the query string: a curated brand word or a model-code token. Accessory
 *  queries (case, charger) never carry device intent and pass untouched. */
export function queryHasDeviceIntent(query: string): boolean {
  return titleHasDeviceIntent(query) || curatedBrandInTitle(query) !== null;
}

export interface DeviceLeadFlags {
  /** Device-intent query, zero device rows rendered, ≥1 accessory rendered. */
  deviceLeadPending: boolean;
  /** Zero Kuwait-primary hits among rendered rows, fallback rows rendered. */
  kuwaitPendingStatus: boolean;
}

/** REEA-793 — derive BOTH honesty flags from the same offer state the page
 *  renders. Pure: no fetches, no clocks, no env — the flags are a function of
 *  (query, rendered products) so a cached snapshot re-derives identically and
 *  the flags can never disagree with what is actually on screen. An empty
 *  rendered set flags neither (the provisional-zero skeleton owns that state,
 *  REEA-437 grammar). REEA-835 — `kuwaitPendingStatus` keys on the rendered
 *  set alone (ANY query: a non-device first paint must be able to say "no
 *  Kuwait answer yet" too); `deviceLeadPending` keeps its device-intent gate
 *  because its pending row only makes sense under device intent. */
export function deviceLeadFlags(
  query: string,
  products: readonly NormalizedProduct[],
): DeviceLeadFlags {
  if (products.length === 0) {
    return { deviceLeadPending: false, kuwaitPendingStatus: false };
  }
  const deviceIntent = queryHasDeviceIntent(query);
  let devices = 0;
  let accessories = 0;
  let kuwait = false;
  for (const p of products) {
    if (isAccessoryTitle(p.title)) accessories += 1;
    else devices += 1;
    if (!kuwait) {
      for (const o of p.offers) {
        if (KUWAIT_PRIMARY_MERCHANTS.includes(o.merchant)) {
          kuwait = true;
          break;
        }
      }
    }
  }
  return {
    // Device offer missed the budget: accessories rendered, devices did not.
    deviceLeadPending: deviceIntent && devices === 0 && accessories > 0,
    // Kuwait-primary missed the budget: fallback offers rendered, none of the
    // four Kuwait-primary merchants has a single rendered offer.
    kuwaitPendingStatus: kuwait === false,
  };
}

/** REEA-793 B1 — re-head a snapshot so the matching device-family offer
 *  leads: device rows (non-accessory titles) first, everything else keeping
 *  its stored order behind them. Only meaningful under a device-intent
 *  query; plain and accessory queries pass through unchanged. Pure and
 *  idempotent (stable two-pass partition, same contract as narrowSkuLead):
 *  a snapshot narrowed twice reads identical, so a memo hit of an
 *  already-narrowed snapshot cannot drift. When NO device row rendered the
 *  stored order stands — the pending-row flag above carries the honesty
 *  state, the list is never re-ranked into a fake device lead. */
export function deviceLeadSnap<T extends { title: string }>(
  query: string,
  products: readonly T[],
): T[] {
  if (!queryHasDeviceIntent(query)) return [...products];
  return narrowDeviceLead(query, products, (p) => !isAccessoryTitle(p.title));
}
