import type { Coupon, PriceOffer } from "@/types/product";
import type { CountryCode } from "@/lib/country";
import { effectivePrice, effectivePriceKwd, formatCountryPrice } from "@/lib/format";
import { clientLocale, getStrings, type Locale } from "@/lib/i18n";

/**
 * REEA-760 — coupon honesty line (design spec eb16258c on REEA-746, ACCEPTed
 * via REEA-748; PM brief 58623331). One flex row per issuing retailer inside
 * the card coupon slot: chip → attribution → effective number. Every visible
 * coupon redeems in ONE step: the chip carries the CODE verbatim (paste and
 * go), otherwise the exact auto-note ("auto-applied at checkout" / Arabic
 * form) — no stacked amounts, never "+N more". The effective number prints
 * exactly ONCE per card, on the row whose retailer holds the cheapest
 * matching offer: cheapest offer price minus that retailer's BEST SINGLE
 * coupon (largest delivered value — never stacked), printed through the
 * existing effectivePrice arithmetic + headline formatter (≤2 decimals,
 * identical formatted figure EN⇄AR), isolated in <bdi>. State B (coupons []):
 * renders NOTHING — no placeholder, no reserved height. Truncation priority
 * number > chip > attribution comes from exactly three rules: nowrap number,
 * capped chip (globals.css component table), wrapping attribution.
 */

export interface CouponRow {
  coupon: Coupon;
  /** Issuing retailer — stamped per hop at normalization; records without
   *  one fall back to the card's cheapest ANSWERING merchant, never a guess. */
  merchant: string;
  /** Printed effective figure — only on the cheapest retailer's row. */
  effectiveLabel: string | null;
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
 * one truth. Every non-leading row is chip + attribution only. Pure on the
 * served figures.
 */
export function buildCouponRows(
  coupons: Coupon[],
  offers: PriceOffer[],
  country: CountryCode | null,
): CouponRow[] {
  // Cheapest ANSWERING merchant in KWD-space (REEA-254/REEA-604 rule — the
  // same normalized key sortOffers ranks on), ties keep the first seen.
  let cheapest: PriceOffer | null = null;
  for (const o of offers) {
    if (!cheapest) cheapest = o;
    else if (
      effectivePriceKwd(o.price, o.currency, { wasPrice: o.wasPrice }) <
      effectivePriceKwd(cheapest.price, cheapest.currency, { wasPrice: cheapest.wasPrice })
    )
      cheapest = o;
  }
  const cheapestMerchant = cheapest?.merchant ?? "";
  // Group per issuing retailer — best single coupon wins the slot.
  const groups = new Map<string, { best: Coupon; delivered: number }>();
  for (const coupon of coupons) {
    const merchant = coupon.merchant?.trim() || cheapestMerchant;
    const lead = leadOffer(offers, merchant) ?? offers[0] ?? null;
    const rawKey = lead
      ? effectivePriceKwd(lead.price, lead.currency, { wasPrice: lead.wasPrice })
      : 0;
    const couponedKey = lead
      ? effectivePriceKwd(lead.price, lead.currency, { wasPrice: lead.wasPrice, couponDiscount: coupon.discount })
      : 0;
    const delivered = lead ? Math.max(0, rawKey - couponedKey) : 0;
    const held = groups.get(merchant);
    if (!held || delivered > held.delivered) groups.set(merchant, { best: coupon, delivered });
  }
  const rows: CouponRow[] = [];
  groups.forEach(({ best }, merchant) => {
    let effectiveLabel: string | null = null;
    // Once per card, on the row whose retailer holds the cheapest matching
    // offer; with no offers at all there is nothing to compute on.
    if (merchant === cheapestMerchant || cheapestMerchant === "") {
      const lead = leadOffer(offers, merchant);
      if (lead) {
        const eff = effectivePrice(lead, best);
        if (eff != null) {
          // Intl stamps its currency space as NBSP; the coupon figure rides
          // the sheet's ASCII-space label rule (format.ts REEA-488 note) so
          // the bdi reads identically EN⇄AR (spec §5).
          effectiveLabel = formatCountryPrice(eff, lead.currency, country).primary.replace(
            /\u00A0/g,
            " ",
          );
        }
      }
    }
    rows.push({ coupon: best, merchant, effectiveLabel });
  });
  return rows;
}

/**
 * One coupon row: `.coupon-badge` chip → `.coupon-via` attribution →
 * `.coupon-effective` number, per the accepted DOM skeleton (§1). Layout
 * rides the existing utilities (flex-wrap, gap-x-2/gap-y-1 = the sheet's
 * --rc-space-2/--rc-space-1 steps, mt-2 seats the line under the offer row);
 * typography and the responsive chip caps live in the globals.css component
 * table from existing tokens — zero new custom properties. Merchant name and
 * the effective figure ride <bdi> isolates so RTL flow never reorders them.
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
      {row.effectiveLabel != null && (
        <span className="coupon-effective">
          {`${t.couponEffectiveLead} `}
          <bdi>{row.effectiveLabel}</bdi>
        </span>
      )}
    </p>
  );
}
