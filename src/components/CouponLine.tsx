import type { Coupon, PriceOffer } from "@/types/product";
import type { CountryCode } from "@/lib/country";
import { formatCountryPrice } from "@/lib/format";
import { clientLocale, fill, getStrings, type Locale } from "@/lib/i18n";
import { composePrice, effectiveKwdOfOffer, isWasPriceCoupon } from "@/lib/price-composition";

/**
 * REEA-760 — coupon honesty line (design spec eb16258c on REEA-746, ACCEPTed
 * via REEA-748; PM brief 58623331). One flex row per issuing retailer inside
 * the card coupon slot: chip → attribution → applied amount/effective number.
 *
 * REEA-1177 AC 6a-2/6a-3 — the line states the APPLIED amount (listed −
 * price) for the row it sits on, or "up to … off at checkout" when the
 * coupon is conditional and its applied value is unknown. A `code:null`
 * entry whose amount is the offer's own was-price markdown is filtered out
 * before this line ever renders (it is the card's composition statement, not
 * a coupon).
 */

export interface CouponRow {
  coupon: Coupon;
  /** Issuing retailer — stamped per hop at normalization; records without
   *  one fall back to the card's cheapest ANSWERING merchant, never a guess. */
  merchant: string;
  /** Printed effective figure — only on the cheapest retailer's row. */
  effectiveLabel: string | null;
  /** REEA-1177 AC 6a-2 — the applied amount this row actually takes off. */
  appliedLabel: string | null;
  /** REEA-1177 AC 6a-2 — "up to X" when the applied value is conditional. */
  upToLabel: string | null;
}

/** The merchant's cheapest matching offer in card order, null when the
 *  merchant has no offer on this card. */
function leadOffer(sorted: PriceOffer[], merchant: string): PriceOffer | null {
  return sorted.find((o) => merchant === "" || o.merchant === merchant) ?? null;
}

/**
 * Assemble the card's coupon rows: one row per ISSUING retailer, in coupon
 * order. Dedup is keyed per hop, so the same code from two merchants keeps
 * two honest attributions. Within one retailer the BEST SINGLE coupon wins —
 * largest delivered value on that retailer's cheapest matching offer (KWD
 * space per REEA-604, ties keep the first seen). `offers` is expected in the
 * CARD's own order (the sorted array the rows render in), so "cheapest
 * matching offer" here is exactly the figure the card leads with — one key,
 * one truth. Every row states its applied amount (or the honest "up to");
 * only the leading row prints the effective figure, once.
 */
export function buildCouponRows(
  coupons: Coupon[],
  offers: PriceOffer[],
  country: CountryCode | null,
): CouponRow[] {
  // REEA-1177 AC 6a-3 — derived was-price entries are not coupons.
  const real = coupons.filter((c) => !isWasPriceCoupon(c, offers));
  // Cheapest ANSWERING merchant in KWD-space (REEA-254/REEA-604 rule — the
  // same normalized key sortOffers ranks on), ties keep the first seen.
  let cheapest: PriceOffer | null = null;
  for (const o of offers) {
    if (!cheapest) cheapest = o;
    else if (effectiveKwdOfOffer(o) < effectiveKwdOfOffer(cheapest)) cheapest = o;
  }
  const cheapestMerchant = cheapest?.merchant ?? "";
  // Group per issuing retailer — best single coupon wins the slot.
  const groups = new Map<string, { best: Coupon; applied: number | null; effective: number | null }>();
  for (const coupon of real) {
    const merchant = coupon.merchant?.trim() || cheapestMerchant;
    const lead = leadOffer(offers, merchant);
    // A stamped coupon whose merchant has no row on this market-scoped card
    // has nothing to reconcile against — do not invent a fallback row.
    if (!lead && coupon.merchant?.trim()) continue;
    const target = lead ?? offers[0] ?? null;
    const composed = target
      ? composePrice({
          price: target.price,
          currency: target.currency,
          wasPrice: target.wasPrice,
          coupon,
        })
      : null;
    const applied = composed?.priceComposition.appliedDiscount ?? null;
    const effective = composed?.priceComposition.effective ?? null;
    const delivered = applied ?? 0;
    const held = groups.get(merchant);
    if (!held || delivered > (held.applied ?? 0)) {
      groups.set(merchant, { best: coupon, applied, effective });
    }
  }
  const rows: CouponRow[] = [];
  groups.forEach(({ best, applied, effective }, merchant) => {
    const lead = leadOffer(offers, merchant) ?? offers[0] ?? null;
    const appliedLabel =
      applied != null && lead
        ? formatCountryPrice(applied, lead.currency, country).primary.replace(/\u00A0/g, " ")
        : null;
    const upToLabel = applied == null ? best.discount : null;
    // Once per card, on the row whose retailer holds the cheapest matching
    // offer; with no offers at all there is nothing to compute on.
    let effectiveLabel: string | null = null;
    if ((merchant === cheapestMerchant || cheapestMerchant === "") && lead && effective != null) {
      effectiveLabel = formatCountryPrice(effective, lead.currency, country).primary.replace(
        /\u00A0/g,
        " ",
      );
    }
    rows.push({ coupon: best, merchant, effectiveLabel, appliedLabel, upToLabel });
  });
  return rows;
}

/**
 * One coupon row: `.coupon-badge` chip → `.coupon-via` attribution →
 * `.coupon-applied` amount / `.coupon-effective` number. Layout rides the
 * existing utilities (flex-wrap, gap-x-2/gap-y-1 = the sheet's
 * --rc-space-2/--rc-space-1 steps, mt-2 seats the line under the offer row);
 * typography and the responsive chip caps live in the globals.css component
 * table from existing tokens — zero new custom properties. Merchant name and
 * the figures ride <bdi> isolates so RTL flow never reorders them.
 */
export default function CouponLine({
  row,
  locale,
}: {
  row: CouponRow;
  /** REEA-279 chrome locale resolved server-side; client chain otherwise. */
  locale?: Locale;
}) {
  const t = getStrings(locale ?? clientLocale());
  // Chip: code verbatim in BOTH locales (Latin codes render as-is), else the
  // exact auto-note — the one-step redeemability of the accepted spec.
  const chip = row.coupon.code?.trim() || t.couponAutoNote;
  return (
    <p className="coupon-line mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="coupon-badge inline-flex min-w-0 items-center overflow-hidden text-ellipsis whitespace-nowrap">
        <>{chip}</>
      </span>
      <span className="coupon-via">
        {`${t.couponViaLead} `}
        <bdi>{row.merchant}</bdi>
      </span>
      {row.appliedLabel != null ? (
        <span className="coupon-applied">
          {`${fill(t.couponAppliedAtCheckout, { x: row.appliedLabel })}`}
        </span>
      ) : row.upToLabel != null ? (
        <span className="coupon-applied">
          {`${fill(t.couponUpTo, { x: row.upToLabel })}`}
        </span>
      ) : null}
      {row.effectiveLabel != null && (
        <span className="coupon-effective">
          {`${t.couponEffectiveLead} `}
          <bdi>{row.effectiveLabel}</bdi>
        </span>
      )}
    </p>
  );
}
