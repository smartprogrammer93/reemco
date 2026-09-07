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
import { useEffect, useState } from "react";
import { useCollection, type CollectionPhase } from "@/lib/collect/useCollection";
import type { CollectJob, LiveOffer } from "@/lib/collect/types";
import { collectedAgoLabel } from "@/lib/collect/types";
import { filterOffersByCountry, type CountryCode } from "@/lib/country";
import { formatPrimaryPrice } from "@/lib/format";
import TrackedOutboundLink from "@/components/TrackedOutboundLink";
import CollectionPulse, { PulseOfferCascade } from "@/components/CollectionPulse";

function OfferRow({ offer, best }: { offer: LiveOffer; best: boolean }) {
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
            Best price
          </span>
        )}
        <span style={{ color: "var(--rc-body-text)", font: "var(--rc-text-body)" }}>
          {offer.inStock ? "In stock" : "Out of stock"}
        </span>
      </div>
      {/* Provenance line (AC4): retailer + domain, collected-at, live/cache. */}
      <p style={{ font: "var(--rc-text-small)", color: "var(--rc-body-text)", marginTop: 4 }}>
        {offer.merchant} ({offer.domain}) · collected {ago ?? "date unknown"} · {offer.method}
      </p>
      <TrackedOutboundLink
        href={offer.url}
        query=""
        rank={0}
        itemId={offer.merchant}
        className="hover:underline"
        style={{ font: "var(--rc-text-small)", color: "var(--rc-primary)" }}
      >
        View at retailer →
      </TrackedOutboundLink>
    </li>
  );
}

function sortOffers(offers: LiveOffer[]): LiveOffer[] {
  return [...offers].sort((a, b) => a.price - b.price);
}

export default function CollectionPanel({
  productId,
  currency,
  country = null,
}: {
  productId: string;
  currency: string;
  /** REEA-170 active country selection; LiveOffer rows carry their currency. */
  country?: CountryCode | null;
}) {
  const { state, cachedNoticeAt, start, retryRetailer } = useCollection(productId);
  const [staleFallback, setStaleFallback] = useState<CollectJob | null>(null);
  // Ticking clock for the elapsed label — updates via interval, never during render.
  const [now, setNow] = useState(() => Date.now());
  const collecting = (state as CollectionPhase).kind === "polling";
  useEffect(() => {
    if (!collecting) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [collecting]);

  // Always-collect (realtime-policy §4): selecting a product ALWAYS starts a
  // live run. With a same-tab snapshot the hook renders it labeled while this
  // revalidation runs in the background; cold mounts show the starting state.
  useEffect(() => {
    void start();
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
      <section aria-label="Live price collection" style={{ marginTop: 16 }}>
        <p style={{ font: "var(--rc-text-body)", color: "var(--rc-body-text)" }}>
          {phase.kind === "starting" ? "Starting live collection…" : "Live collection idle."}{" "}
          <button
            type="button"
            onClick={() => void start({ force: true })}
            className="hover:underline"
            style={{ font: "var(--rc-text-body)", color: "var(--rc-primary)" }}
          >
            Collect now
          </button>
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Live price collection" style={{ marginTop: 16 }}>
      {job && (
        <CollectionPulse
          job={job}
          elapsedLabel={
            job.status === "collecting"
              ? `${Math.max(0, Math.round((now - Date.parse(job.startedAt)) / 1000))}s`
              : undefined
          }
          onRetryRetailer={(retailer) => void retryRetailer(retailer, job.jobId)}
        />
      )}

      {job && job.offers.length > 0 && (
        <PulseOfferCascade offers={filterOffersByCountry(sortOffers(job.offers), country)} />
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
            {job.error ?? "Collection failed"}
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
            Retry collection
          </button>
          {staleFallback && staleFallback.offers.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <p style={{ font: "var(--rc-text-small)", color: "var(--rc-body-text)" }}>
                Showing last cached results — collected{" "}
                {collectedAgoLabel(staleFallback.finishedAt ?? staleFallback.startedAt, now) ??
                  "at an unknown time"}{" "}
                (stale)
              </p>
              <ul style={{ listStyle: "none", padding: 0 }}>
                {filterOffersByCountry(sortOffers(staleFallback.offers), country).map((offer, i) => (
                  <OfferRow
                    key={`${offer.merchant}-stale`}
                    offer={{ ...offer, method: "cache" }}
                    best={i === 0}
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
          Live results · collected{" "}
          {collectedAgoLabel(job.finishedAt ?? job.startedAt, now) ?? "just now"} ·{" "}
          <button
            type="button"
            onClick={() => void start({ force: true })}
            className="hover:underline"
            style={{ font: "var(--rc-text-small)", color: "var(--rc-primary)" }}
          >
            Collect again
          </button>
        </p>
      )}
      <p style={{ font: "var(--rc-text-small)", color: "var(--rc-body-text)", marginTop: 4 }}>
        Prices in {currency}. Collection is scoped to this product only.
      </p>
    </section>
  );
}
