"use client";

import type {
  NormalizedProduct,
  PriceOffer,
} from "@/types/product";
import {
  formatExpiry,
  formatPrice,
  sortOffers,
} from "@/lib/format";

function OfferRow({ offer }: { offer: PriceOffer }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <span className="text-sm">{offer.merchant}</span>
      <span className="flex items-center gap-3">
        <span
          className={`text-xs ${offer.inStock ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}
        >
          {offer.inStock ? "In stock" : "Out of stock"}
        </span>
        <span className="font-medium tabular-nums">
          {formatPrice(offer.price, offer.currency)}
        </span>
        <a
          href={offer.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs underline underline-offset-2 hover:opacity-80"
        >
          Visit
        </a>
      </span>
    </li>
  );
}

export default function ProductResultCard({
  product,
}: {
  product: NormalizedProduct;
}) {
  const offers = sortOffers(product.offers);
  const best = offers[0];

  return (
    <article className="rounded-xl border p-5">
      <header className="mb-4">
        <h2 className="text-lg font-semibold">{product.title}</h2>
        <p className="text-sm text-zinc-500">by {product.brand}</p>
        {best && (
          <p className="mt-2 text-2xl font-bold tabular-nums">
            {formatPrice(best.price, best.currency)}{" "}
            <span className="text-sm font-normal text-zinc-500">
              best price at {best.merchant}
            </span>
          </p>
        )}
      </header>

      <section aria-label="Prices and availability">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Prices &amp; availability
        </h3>
        {offers.length === 0 ? (
          <p className="text-sm text-zinc-500">No offers available.</p>
        ) : (
          <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {offers.map((o) => (
              <OfferRow key={`${o.merchant}-${o.url}`} offer={o} />
            ))}
          </ul>
        )}
      </section>

      <section
        aria-label="Coupons"
        className="mt-4"
      >
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Coupons
        </h3>
        {product.coupons.length === 0 ? (
          <p className="text-sm text-zinc-500">No coupons found.</p>
        ) : (
          <ul className="space-y-1">
            {product.coupons.map((c, i) => (
              <li key={`${c.code ?? "coupon"}-${i}`} className="text-sm">
                <span className="font-medium text-emerald-700 dark:text-emerald-400">
                  {c.discount}
                </span>
                {c.code && (
                  <>
                    {" — code "}
                    <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
                      {c.code}
                    </code>
                  </>
                )}
                <span className="text-zinc-600 dark:text-zinc-400">
                  {" — "}
                  {c.description}
                  {formatExpiry(c.expiresAt) &&
                    ` (expires ${formatExpiry(c.expiresAt)})`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Variations" className="mt-4">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Variations
        </h3>
        {product.variations.length === 0 ? (
          <p className="text-sm text-zinc-500">No variations.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {product.variations.map((v) => (
              <li
                key={v.id}
                className="rounded-full border px-3 py-1 text-xs"
              >
                {v.label}
                {v.priceDelta !== 0 && (
                  <span className="text-zinc-500">
                    {" "}
                    {v.priceDelta > 0 ? "+" : "−"}
                    {Math.abs(v.priceDelta).toFixed(2)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Alternatives" className="mt-4">
        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Alternatives
        </h3>
        {product.alternatives.length === 0 ? (
          <p className="text-sm text-zinc-500">No alternatives.</p>
        ) : (
          <ul className="space-y-1">
            {product.alternatives.map((a) => (
              <li key={a.productId} className="text-sm">
                <a
                  href={`/results?q=${encodeURIComponent(a.title)}`}
                  className="underline underline-offset-2 hover:opacity-80"
                >
                  {a.title}
                </a>
                <span className="text-zinc-500">
                  {" "}
                  from {formatPrice(a.fromPrice, best?.currency ?? "USD")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}
