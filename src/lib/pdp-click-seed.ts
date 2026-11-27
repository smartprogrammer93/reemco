/**
 * REEA-1246 (Bet 7) — the clicked card's offer set rides the product link.
 *
 * The defect: a shelf card is painted from a STREAMED stage of the query
 * fan-out, so the shopper can click it before the run's final stage has
 * written the query memo. The product page then re-runs its own fan-out
 * bounded by the page completion budget and paints a DIFFERENT partial set —
 * measured on the served head: card "Wibi KD 314.90" → cold PDP "Eureka
 * KD 331.90" (5.1% worse, different retailer), while the shelf already knew
 * the 314.90 in the same request.
 *
 * The card and the PDP are one click apart, so the click itself must carry
 * the offer set the shopper was looking at. This module is the pure, tested
 * codec for that handoff:
 *
 *  - `encodeClickSeed` takes the exact offer rows the card rendered (the
 *    shared `visibleShelfOffers` projection) and serialises them — one row
 *    per retailer first, then extra real prices — into one compact
 *    base64url token that rides the product link as `?o=`;
 *  - `decodeClickSeed` validates the token against the same rules the live
 *    collector applies (known ISO currency, positive finite price, safe
 *    http(s) listing URL, parseable collection stamp) and drops anything
 *    that does not survive. It never trusts the URL blindly;
 *  - `mergeSeededOfferRows` seeds the PDP with those rows WITHOUT letting
 *    them override this page's own fresher rows (the live re-check always
 *    wins on merchant+listing);
 *  - `pdpHeadlineClaim` is the ONE headline decision: the cheapest in-stock
 *    in-market offer, else the disclosed cross-market one, else — when only
 *    out-of-stock lanes answered — the cheapest row as an explicit "price
 *    reference", never an unqualified best-price claim.
 *
 * Live-data fidelity: a seeded row is not bundled data. It carries the
 * `collectedAt` stamp of the live fetch that produced it and is rendered as
 * `method: "cache"` (Needs verification) until this page's own re-check
 * replaces it. An unstamped row is never seeded.
 *
 * Pure and client-safe: no React, no I/O, no clock beyond the injected
 * `nowMs` guard.
 */
import type { CountryCode } from "@/lib/country";
import { normalizedListingUrlOf } from "@/lib/collect/types";
import {
  cheapestCrossMarketOffer,
  headlineOfferFor,
  isCrossMarketOffer,
} from "@/lib/market";
import { effectiveKwdOfOffer } from "@/lib/price-composition";
import { assertSafeExternalUrl } from "@/lib/safe-url";
import type { PriceComposition, PriceOffer } from "@/types/product";

/** Query parameter carrying the clicked card's offer set on a PDP link. */
export const PDP_SEED_PARAM = "o";

/** Upper bound on seeded rows: every retailer first, then extra prices.
 *  Sized so a 9-retailer card's URLs stay well inside the 8 KB request-line
 *  limit the serving proxy allows. */
export const PDP_SEED_MAX_ROWS = 12;

/** Version tag so a future shape change can never be misread as this one. */
const PDP_SEED_VERSION = 1;

/** Longest merchant label accepted from the URL (retailer names are short). */
const MAX_MERCHANT_LENGTH = 120;

/** Longest ISO-4217-shaped currency string accepted. */
const CURRENCY_RE = /^[A-Z]{3}$/;

/** A seeded row: a live observation replayed from the click, never a bundle.
 *  It satisfies both the served `PriceOffer` shape (composition, sanity) and
 *  the collector's `LiveOffer` shape (domain, stamp, method), so the product
 *  page can merge it into either representation without a cast. */
export interface SeededOffer extends PriceOffer {
  domain: string;
  collectedAt: string;
  collectedAtEpochMs: number;
  method: "live" | "cache";
  /** True when the shelf rendered the row from its labeled last-seen snapshot. */
  fromSnapshot?: boolean;
}

export interface ClickSeed {
  /** The productId the card was rendered for — a mismatched URL is ignored. */
  productId: string;
  rows: SeededOffer[];
}

/* ---------------------------------------------------------------------------
 * Encoding — one row per retailer first so a 9-retailer card cannot lose a
 * retailer to the cap, then the remaining real prices in served order.
 * ------------------------------------------------------------------------- */

function rowStampMs(offer: PriceOffer): number | null {
  const epoch = (offer as { collectedAtEpochMs?: number }).collectedAtEpochMs;
  if (typeof epoch === "number" && Number.isFinite(epoch) && epoch > 0) return epoch;
  const parsed = Date.parse((offer as { collectedAt?: string }).collectedAt ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function merchantKey(merchant: string): string {
  return merchant.trim().toLowerCase();
}

function seedableRows(offers: readonly PriceOffer[]): PriceOffer[] {
  const ranked = [...offers].sort((a, b) => {
    // In-stock first, then the card's own effective order — the same ladder
    // the shelf painted.
    if (a.inStock !== b.inStock) return a.inStock ? -1 : 1;
    return effectiveKwdOfOffer(a) - effectiveKwdOfOffer(b);
  });
  const picked: PriceOffer[] = [];
  const retailers = new Set<string>();
  for (const offer of ranked) {
    if (picked.length >= PDP_SEED_MAX_ROWS) break;
    const key = merchantKey(offer.merchant);
    if (key === "" || retailers.has(key)) continue;
    retailers.add(key);
    picked.push(offer);
  }
  for (const offer of ranked) {
    if (picked.length >= PDP_SEED_MAX_ROWS) break;
    if (picked.includes(offer)) continue;
    picked.push(offer);
  }
  return picked;
}

/** Base64url of a UTF-8 string, using only web globals so the client bundle
 *  (the card builds the link) and the Node server decode the same token. */
function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(token: string): string {
  const normalised = token.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalised + "=".repeat((4 - (normalised.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function safeUrlOf(url: unknown): string | null {
  if (typeof url !== "string" || url === "") return null;
  try {
    assertSafeExternalUrl(url);
    return url;
  } catch {
    return null;
  }
}

function sanityOf(offer: PriceOffer): SeededOffer["sanity"] | undefined {
  const sanity = offer.sanity;
  if (!sanity) return undefined;
  if (sanity.status !== "ok" && sanity.status !== "flagged") return undefined;
  return {
    status: sanity.status,
    ...(sanity.reason ? { reason: sanity.reason } : {}),
    ...(typeof sanity.ratioToMedian === "number" ? { ratioToMedian: sanity.ratioToMedian } : {}),
  };
}

/**
 * Serialise the card's rendered offer rows into the link token, or null when
 * nothing can be carried (no stamped, safe, priced row).
 */
export function encodeClickSeed(
  productId: string,
  offers: readonly PriceOffer[],
): string | null {
  const rows: unknown[][] = [];
  for (const offer of seedableRows(offers)) {
    const stamp = rowStampMs(offer);
    const url = safeUrlOf(offer.url);
    const merchant = (offer.merchant ?? "").trim();
    const currency = (offer.currency ?? "").trim().toUpperCase();
    if (stamp == null || url == null || merchant === "") continue;
    if (!Number.isFinite(offer.price) || offer.price <= 0) continue;
    if (!CURRENCY_RE.test(currency)) continue;
    if (merchant.length > MAX_MERCHANT_LENGTH) continue;
    const wasPrice =
      typeof offer.wasPrice === "number" && Number.isFinite(offer.wasPrice) && offer.wasPrice > 0
        ? offer.wasPrice
        : null;
    const effectivePrice =
      typeof offer.effectivePrice === "number" && Number.isFinite(offer.effectivePrice)
        ? offer.effectivePrice
        : null;
    const composition = offer.priceComposition
      ? [
          offer.priceComposition.listed,
          offer.priceComposition.appliedDiscount,
          offer.priceComposition.effective,
          offer.priceComposition.kind,
        ]
      : null;
    rows.push([
      merchant,
      offer.price,
      currency,
      offer.inStock ? 1 : 0,
      stamp,
      url,
      wasPrice,
      effectivePrice,
      composition,
      (offer as { fromSnapshot?: boolean }).fromSnapshot ? 1 : 0,
      sanityOf(offer)?.status === "flagged" ? 1 : 0,
      sanityOf(offer)?.reason ?? null,
      // REEA-1246 — the sanity ratio must ride along: the card excludes a
      // low-ratio row from its headline (isPossibleMismatchOffer), so the PDP
      // must read the same verdict instead of trusting a row the card demoted.
      sanityOf(offer)?.ratioToMedian ?? null,
    ]);
  }
  if (rows.length === 0) return null;
  const payload = JSON.stringify([PDP_SEED_VERSION, productId, rows]);
  return toBase64Url(payload);
}

/* ---------------------------------------------------------------------------
 * Decoding — strict, fail-closed. Anything the URL gets wrong is dropped, so
 * a tampered link can never invent a price or a retailer.
 * ------------------------------------------------------------------------- */

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asComposition(value: unknown): PriceComposition | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const listed = asFiniteNumber(value[0]);
  const applied = value[1] == null ? null : asFiniteNumber(value[1]);
  const effective = value[2] == null ? null : asFiniteNumber(value[2]);
  const kind = value[3];
  if (listed == null || listed < 0) return null;
  if (kind !== "was_price" && kind !== "coupon") return null;
  return {
    listed,
    appliedDiscount: applied,
    effective,
    kind,
  };
}

function decodeRows(
  raw: unknown,
  nowMs: number,
): SeededOffer[] {
  if (!Array.isArray(raw)) return [];
  const rows: SeededOffer[] = [];
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 6) continue;
    const merchantRaw = entry[0];
    const price = asFiniteNumber(entry[1]);
    const currencyRaw = entry[2];
    const inStock = entry[3];
    const stamp = asFiniteNumber(entry[4]);
    const url = safeUrlOf(entry[5]);
    if (typeof merchantRaw !== "string") continue;
    const merchant = merchantRaw.trim().replace(/\s+/g, " ");
    if (merchant === "" || merchant.length > MAX_MERCHANT_LENGTH) continue;
    if (price == null || price <= 0 || price > 10_000_000) continue;
    if (typeof currencyRaw !== "string") continue;
    const currency = currencyRaw.trim().toUpperCase();
    if (!CURRENCY_RE.test(currency)) continue;
    if (inStock !== 0 && inStock !== 1) continue;
    if (stamp == null || stamp <= 0) continue;
    if (url == null) continue;
    // A stamp in the future is a clock skew artefact: clamp to now so the
    // row cannot claim to have been checked after this render.
    const observedAt = Math.min(stamp, nowMs);
    const wasPrice = entry[6] == null ? null : asFiniteNumber(entry[6]);
    const effectivePrice = entry[7] == null ? null : asFiniteNumber(entry[7]);
    const composition = asComposition(entry[8]);
    const fromSnapshot = entry[9] === 1;
    const flagged = entry[10] === 1;
    const reason = typeof entry[11] === "string" && entry[11] !== "" ? entry[11] : undefined;
    const ratio = entry[12] == null ? null : asFiniteNumber(entry[12]);
    let domain = "";
    try {
      domain = new URL(url).hostname;
    } catch {
      continue;
    }
    const sanity: NonNullable<PriceOffer["sanity"]> | null =
      flagged || ratio != null
        ? {
            status: flagged ? ("flagged" as const) : ("ok" as const),
            ...(reason ? { reason: reason as NonNullable<PriceOffer["sanity"]>["reason"] } : {}),
            ...(ratio != null ? { ratioToMedian: ratio } : {}),
          }
        : null;
    rows.push({
      merchant,
      domain,
      price,
      currency,
      url,
      inStock: inStock === 1,
      ...(wasPrice != null && wasPrice > 0 ? { wasPrice } : {}),
      collectedAt: new Date(observedAt).toISOString(),
      collectedAtEpochMs: observedAt,
      method: "cache",
      ...(effectivePrice != null ? { effectivePrice } : {}),
      ...(composition ? { priceComposition: composition } : {}),
      ...(fromSnapshot ? { fromSnapshot: true } : {}),
      ...(sanity ? { sanity } : {}),
    });
  }
  return rows;
}

/**
 * Decode a product link's seed token. Returns null when the token is absent,
 * malformed, minted for a different product, or carries no usable row — the
 * page then behaves exactly as before this ticket.
 */
export function decodeClickSeed(
  token: string | string[] | undefined | null,
  expectedProductId: string,
  nowMs: number = Date.now(),
): ClickSeed | null {
  if (typeof token !== "string" || token === "") return null;
  let payload: unknown;
  try {
    payload = JSON.parse(fromBase64Url(token));
  } catch {
    return null;
  }
  if (!Array.isArray(payload) || payload.length < 3) return null;
  const [version, productId, rawRows] = payload;
  if (version !== PDP_SEED_VERSION) return null;
  if (typeof productId !== "string" || productId !== expectedProductId) return null;
  const rows = decodeRows(rawRows, nowMs);
  if (rows.length === 0) return null;
  return { productId, rows };
}

/* ---------------------------------------------------------------------------
 * Merging — the page's own rows (memo inheritance or this run's answer) always
 * win; a seeded row is only appended when this page does not already hold the
 * same listing or the same real price from that retailer.
 * ------------------------------------------------------------------------- */

export interface SeedMergeRow {
  merchant: string;
  url: string;
  currency: string;
  price: number;
}

function offerKeyOf(row: SeedMergeRow): string {
  return `${merchantKey(row.merchant)}|${row.currency.toUpperCase()}|${row.price}`;
}

export function mergeSeededOfferRows<T extends SeedMergeRow>(
  base: readonly T[],
  seed: readonly T[],
): T[] {
  const out = [...base];
  const listings = new Set(out.map((row) => `${merchantKey(row.merchant)}|${normalizedListingUrlOf(row.url)}`));
  const offers = new Set(out.map(offerKeyOf));
  for (const row of seed) {
    const listing = `${merchantKey(row.merchant)}|${normalizedListingUrlOf(row.url)}`;
    if (listings.has(listing) || offers.has(offerKeyOf(row))) continue;
    out.push(row);
    listings.add(listing);
    offers.add(offerKeyOf(row));
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Headline integrity — the ONE decision every product surface reads.
 * ------------------------------------------------------------------------- */

export type PdpHeadlineKind = "in-stock" | "out-of-stock-reference" | "none";

export interface PdpHeadline {
  best: PriceOffer | null;
  kind: PdpHeadlineKind;
}

/**
 * Pick the headline offer and name its claim. In-stock always wins; when no
 * in-stock offer is known, the cheapest row is a disclosed PRICE REFERENCE,
 * never a "best price". A cross-market offer is only the headline when there
 * is no in-market one (the existing AC 6d-3 exception).
 */
export function pdpHeadlineClaim<T extends PriceOffer>(
  offers: readonly T[],
  scope: CountryCode | null,
): PdpHeadline {
  if (offers.length === 0) return { best: null, kind: "none" };
  const localBest = headlineOfferFor(offers, scope);
  if (localBest) return { best: localBest, kind: "in-stock" };
  const crossBest = cheapestCrossMarketOffer(offers, scope);
  if (crossBest) return { best: crossBest, kind: "in-stock" };
  // Nothing buyable answered: keep the cheapest figure as a reference. The
  // in-market pool leads so a foreign price never displaces the market the
  // page speaks for.
  const local = scope === null ? offers : offers.filter((o) => !isCrossMarketOffer(o, scope));
  const pool = local.length > 0 ? local : offers;
  const cheapest = pool.reduce((a, b) =>
    effectiveKwdOfOffer(a) <= effectiveKwdOfOffer(b) ? a : b,
  );
  return { best: cheapest, kind: "out-of-stock-reference" };
}
