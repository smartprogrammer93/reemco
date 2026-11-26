import type { PriceComposition } from "@/types/product";
import type { CountryCode } from "@/lib/country";
import { formatCountryPrice } from "@/lib/format";
import { clientLocale, fill, getStrings, type Locale } from "@/lib/i18n";

/**
 * REEA-1177 AC 6a-2/6a-6 — the ONE reconciling price statement a shelf card
 * or PDP renders without expanding a disclosure. It is arithmetic on served
 * figures only:
 *
 *   was_price:  Save KD 90 vs Xcite listed price · Listed KD 409.90 − KD 90 = You pay KD 319.90
 *   coupon:     Coupon KD 90 off at checkout · Listed KD 314.90 − KD 90 = You pay KD 224.90
 *
 * A conditional discount whose applied value is unknown prints the listed
 * figure and "up to … off at checkout" — never a subtracted face value. The
 * line wraps (flex-wrap, overflow-wrap) so 375px EN/AR cannot overflow.
 */
export default function PriceCompositionLine({
  composition,
  merchant,
  currency,
  country,
  locale,
  comparison = false,
  couponText,
}: {
  composition: PriceComposition;
  merchant: string;
  currency: string;
  country: CountryCode | null;
  locale?: Locale;
  /** REEA-1147 — only a multi-retailer card states a cross-store "Save"; a
   *  single-retailer card still shows the reconciling arithmetic. */
  comparison?: boolean;
  /** The coupon's own text, used for the honest "up to …" when the applied
   *  value is conditional and unknown. */
  couponText?: string;
}) {
  const t = getStrings(locale ?? clientLocale());
  const applied = composition.appliedDiscount;
  if (applied == null && composition.kind !== "coupon") return null;
  if (applied != null && applied <= 0) return null;

  const listed = formatCountryPrice(composition.listed, currency, country).primary.replace(/\u00A0/g, " ");
  const discount =
    applied != null
      ? formatCountryPrice(applied, currency, country).primary.replace(/\u00A0/g, " ")
      : null;
  const effective =
    composition.effective != null
      ? formatCountryPrice(composition.effective, currency, country).primary.replace(/\u00A0/g, " ")
      : null;

  return (
    <p className="rc-price-composition flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {composition.kind === "was_price" && comparison && discount != null ? (
        <>
          <span className="rc-savings">
            <bdi>{`${t.saveLead} ${discount}`}</bdi>
          </span>
          <span className="rc-savings-basis">{fill(t.savingsBaseline, { x: merchant })}</span>
        </>
      ) : null}
      {composition.kind === "coupon" && discount != null ? (
        <span className="rc-coupon-applied">
          <bdi>{fill(t.couponAppliedAtCheckout, { x: discount })}</bdi>
        </span>
      ) : null}
      {composition.kind === "coupon" && discount == null ? (
        <span className="rc-coupon-applied">
          <bdi>{fill(t.couponUpTo, { x: couponText ?? t.couponLead })}</bdi>
        </span>
      ) : null}
      <span className="rc-composition-math">
        {effective != null && discount != null ? (
          <bdi>
            {fill(t.compositionMath, {
              listed,
              discount,
              effective,
            })}
          </bdi>
        ) : (
          <bdi>{fill(t.compositionListedOnly, { listed })}</bdi>
        )}
      </span>
    </p>
  );
}
