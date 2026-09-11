"use client";

/**
 * REEA-95 — per-product live collection panel.
 *
 * Every product view ALWAYS triggers a live collection run against the
 * retailer adapters (realtime-policy §4). Renders the real per-retailer
 * subtask states from the polling API (progress is never synthetic), offer
 * cards with full provenance, per-retailer retry chips, and the labeled
 * same-tab-session repeat ("Cached — refreshed at …") which clears when fresh
 * data lands. On a failed live run the last completed collection is fetched
 * and rendered labeled with its age — never a silent empty state.
 */
import { Suspense, useEffect, useState, use } from "react";
import { useCollection, type CollectionPhase } from "@/lib/collect/useCollection";
import type { CollectJob, LiveOffer } from "@/lib/collect/types";
import { collectedAgoLabel } from "@/lib/collect/types";
import { filterOffersByCountry, type CountryCode } from "@/lib/country";
import { effectivePriceKwd, formatPrimaryPrice } from "@/lib/format";
import TrackedOutboundLink from "@/components/TrackedOutboundLink";
import CollectionPulse, { PulseOfferCascade } from "@/components/CollectionPulse";
import { clientLocale, getStrings, type Locale } from "@/lib/i18n";

function OfferRow({ offer, best, locale }: { offer: LiveOffer; best: boolean; locale?: Locale }) {
  const t = getStrings(locale ?? clientLocale());
  const ago = collectedAgoLabel(offer.collectedAt);
  return (
    <li
      style={{
        border: `1px solid ${best ? "var(--rc-savings)" : "var(--rc-line)"}`,
        borderRadius: 8,
        padding: 12,
        marginBottom: 8,
      }}
    >
      <div className="flex items-baseline gap-2">
        <strong style={{ fontSize: 20, fontVariantNumeric: "tabular-nums" }}>
          {formatPrimaryPrice(offer.price, offer.currency).label}
        </strong>
        {best && (
          <span
            className="rounded px-2 py-0.5"
            style={{
              font: "var(--rc-text-small)",
              background: "var(--rc-primary-tint, var(--rc-canvas))",
              color: "var(--rc-savings)",
            }}
          >
            {t.bestPrice}
          </span>
        )}
        <span style={{ color: "var(--rc-body-text)", font: "var(--rc-text-body)" }}>
          {offer.inStock ? t.inStock : t.outOfStock}
        </span>
      </div>
      {/* Provenance line (AC4): retailer + domain, collected-at, live/cache. */}
      <p style={{ font: "var(--rc-text-small)", color: "var(--rc-body-text)", marginTop: 4 }}>
        {offer.merchant} ({offer.domain}) · {t.collectedWord} {ago ?? t.dateUnknown} ·{" "}
        {offer.method === "live" ? t.liveWord : t.cachedWord}
      </p>
      <TrackedOutboundLink
        href={offer.url}
        query=""
        rank={0}
        itemId={offer.merchant}
        className="hover:underline"
        style={{ font: "var(--rc-text-small)", color: "var(--rc-primary)" }}
      >
        {t.viewAtRetailer}
      </TrackedOutboundLink>
    </li>
  );
}

/** Cheapest-effective-first (REEA-254 item B): LiveOffer rows carry their own
 *  currency, so the comparison runs on the ONE normalized effective-price key
 *  (effectivePriceKwd — was-price evidence folded, KWD-based) — the same rule
 *  sortOffers applies on the results cards (REEA-604). */
function sortOffers(offers: LiveOffer[]): LiveOffer[] {
  const key = (o: LiveOffer) => effectivePriceKwd(o.price, o.currency, { wasPrice: o.wasPrice });
  return [...offers].sort((a, b) => key(a) - key(b));
}

export default function CollectionPanel(props: {
  productId: string;
  currency: string;
  /** REEA-170 active country selection; LiveOffer rows carry their currency. */
  country?: CountryCode | null;
  /** REEA-279 chrome locale resolved server-side; client chain otherwise. */
  locale?: Locale;
  /** REEA-248 first-offer stage of the collection the server render started. */
  firstStage?: Promise<CollectJob>;
}) {
  return (
    <Suspense fallback={<PanelFallback locale={props.locale} />}>
      <CollectionPanelBody {...props} />
    </Suspense>
  );
}

/* Streaming fallback = today's pre-offer shell: the live-collection label with
   the manual Collect-now control, so the panel area never reads blank while
   the server-started first offer is still in flight (REEA-248 AC1 — same
   grace shape the results page uses for its skeleton). Reload re-runs the
   server render, which re-attaches to (or starts) the live job. */
function PanelFallback({ locale }: { locale?: Locale }) {
  const t = getStrings(locale ?? clientLocale());
  return (
    <section aria-label={t.liveCollectionAria} style={{ marginTop: 16 }}>
      <p style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
        {t.startingLive}{" "}
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="hover:underline"
          style={{ font: "var(--rc-text-body)", color: "var(--rc-primary)" }}
        >
          {t.collectNow}
        </button>
      </p>
    </section>
  );
}

function CollectionPanelBody({
  productId,
  currency,
  country = null,
  locale,
  firstStage,
}: {
  productId: string;
  currency: string;
  country?: CountryCode | null;
  locale?: Locale;
  firstStage?: Promise<CollectJob>;
}) {
  const t = getStrings(locale ?? clientLocale());
  // Server-started staged snapshot (REEA-248): the boundary flushes with the
  // first retailer's answer already in hand; without a server stage (static
  // preview host) this stays the old client-initiated path.
  const snap = firstStage ? use(firstStage) : null;
  const { state, cachedNoticeAt, start, retryRetailer, attach } = useCollection(productId, snap);
  const [staleFallback, setStaleFallback] = useState<CollectJob | null>(null);
  // Ticking clock for the elapsed label — updates via interval, never during render.
  const [now, setNow] = useState(() => Date.now());
  const collecting = (state as CollectionPhase).kind === "polling";
  useEffect(() => {
    if (!collecting) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [collecting]);

  // Always-collect (realtime-policy §4): selecting a product ALWAYS runs live.
  // REEA-248: when the server render already started this product's job the
  // client ATTACHES to it — polling continues the same job, so first paint
  // never double-fetches (AC2) and the manual Collect-now stays a refresh
  // control. Without a server stage the mount starts the run as before.
  useEffect(() => {
    if (snap) attach(snap);
    else void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  // Stale-cache fallback (AC6): on a failed live run with a linked previous job,
  // fetch it and render labeled cached data instead of a silent empty state.
  useEffect(() => {
    const job = state.kind === "terminal" ? state.job : null;
    const previousId = job?.status === "failed" ? job.previousJobId : undefined;
    let cancelled = false;
    void (async () => {
      await Promise.resolve(); // keep setState out of the synchronous effect body
      if (cancelled) return;
      if (!previousId) {
        setStaleFallback(null);
        return;
      }
      try {
        const res = await fetch(`/api/collect-jobs/${previousId}`, {
          cache: "no-store",
        });
        if (res.ok && !cancelled) {
          setStaleFallback((await res.json()) as CollectJob);
        }
      } catch {
        /* no fallback available — error state stands */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state]);

  const phase = state as CollectionPhase;
  const job = phase.kind === "polling" || phase.kind === "terminal" ? phase.job : null;

  if (phase.kind === "idle" || phase.kind === "starting") {
    return (
      <section aria-label={t.liveCollectionAria} style={{ marginTop: 16 }}>
        <p style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
          {phase.kind === "starting" ? t.startingLive : t.idleLive}{" "}
          <button
            type="button"
            onClick={() => void start({ force: true })}
            className="hover:underline"
            style={{ font: "var(--rc-text-body)", color: "var(--rc-primary)" }}
          >
            {t.collectNow}
          </button>
        </p>
      </section>
    );
  }

  return (
    <section aria-label={t.liveCollectionAria} style={{ marginTop: 16 }}>
      {job && (
        <CollectionPulse
          job={job}
          elapsedLabel={
            job.status === "collecting"
              ? `${Math.max(0, Math.round((now - Date.parse(job.startedAt)) / 1000))}s`
              : undefined
          }
          onRetryRetailer={(retailer) => void retryRetailer(retailer, job.jobId)}
          locale={locale}
        />
      )}

      {job && job.offers.length > 0 && (
        <PulseOfferCascade offers={filterOffersByCountry(sortOffers(job.offers), country)} locale={locale} />
      )}

      {/* Full-failure error state with retry CTA (AC6) — never a silent empty state. */}
      {job && job.status === "failed" && (
        <div
          role="alert"
          style={{
            border: "1px solid var(--rc-error)",
            borderRadius: 8,
            padding: 12,
            marginTop: 12,
          }}
        >
          <p style={{ font: "var(--rc-text-body)", color: "var(--rc-error)" }}>
            {job.error ?? t.collectionFailed}
          </p>
          <button
            type="button"
            onClick={() => void start({ force: true })}
            className="rounded px-3 py-1.5"
            style={{
              font: "var(--rc-text-body)",
              background: "var(--rc-primary)",
              color: "#fff",
              marginTop: 8,
            }}
          >
            {t.retryCollection}
          </button>
          {staleFallback && staleFallback.offers.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <p style={{ font: "var(--rc-text-small)", color: "var(--rc-body-text)" }}>
                {t.showingCachedLead}{" "}
                {collectedAgoLabel(staleFallback.finishedAt ?? staleFallback.startedAt, now) ??
                  t.dateUnknown}{" "}
                {t.staleNote}
              </p>
              <ul style={{ listStyle: "none", padding: 0 }}>
                {filterOffersByCountry(sortOffers(staleFallback.offers), country).map((offer, i) => (
                  <OfferRow
                    key={`${offer.merchant}-stale`}
                    offer={{ ...offer, method: "cache" }}
                    best={i === 0}
                    locale={locale}
                  />
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Same-tab repeat label (realtime-policy §4): shown while the previous
          snapshot renders ahead of the background revalidation; clears when
          the fresh collection lands. */}
      {cachedNoticeAt && job && (
        <p style={{ marginTop: 8 }}>
          <span className="cached-chip">
            Cached — refreshed at{" "}
            {new Date(cachedNoticeAt).toLocaleTimeString(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </p>
      )}
      {job && job.status === "complete" && !cachedNoticeAt && (
        <p style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)", marginTop: 8 }}>
          {t.liveResultsLead}{" "}
          {collectedAgoLabel(job.finishedAt ?? job.startedAt, now) ?? t.justNow} ·{" "}
          <button
            type="button"
            onClick={() => void start({ force: true })}
            className="hover:underline"
            style={{ font: "var(--rc-text-small)", color: "var(--rc-primary)" }}
          >
            {t.collectAgain}
          </button>
        </p>
      )}
      <p style={{ font: "var(--rc-text-small)", color: "var(--rc-body-text)", marginTop: 4 }}>
        {`${t.pricesInLead} ${currency}${t.pricesInTail}`}
      </p>
    </section>
  );
}
