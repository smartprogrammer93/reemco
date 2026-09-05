"use client";

/**
 * REEA-84 W1 T4/T5/T6 — per-product collection panel.
 *
 * Renders the real per-retailer subtask states from the polling API (AC2 —
 * progress is never synthetic), offer cards with full provenance (AC3/AC4),
 * per-retailer retry chips (AC6), and the cached-vs-live labeling with the
 * freshness rule (AC5). Stale-cache fallback: when a live run fails, the last
 * completed collection is fetched and rendered labeled with its age (AC6/AC10).
 *
 * Interim styling only — theme v2 lands via the design workstream (REEA-84 W2).
 */
import { useEffect, useState } from "react";
import { useCollection, type CollectionPhase } from "@/lib/collect/useCollection";
import type { CollectJob, LiveOffer } from "@/lib/collect/types";
import { collectedAgoLabel } from "@/lib/collect/types";
import { formatPrice } from "@/lib/format";
import TrackedOutboundLink from "@/components/TrackedOutboundLink";

const SUBTASK_LABEL: Record<string, string> = {
  pending: "Queued",
  collecting: "Collecting…",
  done: "Done",
  failed: "Failed",
  timeout: "Timed out",
};

function ProgressHeader({ job }: { job: CollectJob }) {
  const total = job.subtasks.length || 1;
  const settled = job.subtasks.filter(
    (s) => s.status === "done" || s.status === "failed" || s.status === "timeout",
  ).length;
  const pct = job.status === "collecting" ? Math.round((settled / total) * 100) : 100;
  return (
    <div>
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Collection progress"
        style={{
          height: 6,
          borderRadius: 3,
          background: "var(--color-surface-muted)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background:
              job.status === "failed" ? "var(--color-error)" : "var(--color-deal)",
            transition: "width 300ms ease-out",
          }}
        />
      </div>
      <p style={{ font: "var(--text-small)", marginTop: 4, color: "var(--color-ink-secondary)" }}>
        {job.status === "collecting"
          ? `Collecting live offers… ${settled}/${total} retailers settled`
          : job.status === "complete"
            ? `Live collection complete — ${job.offers.length} offer${job.offers.length === 1 ? "" : "s"}`
            : "Live collection failed"}
      </p>
    </div>
  );
}

function RetailerRows({
  job,
  onRetry,
}: {
  job: CollectJob;
  onRetry: (retailer: string, jobId: string) => void;
}) {
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0" }}>
      {job.subtasks.map((sub) => (
        <li
          key={sub.retailer}
          className="flex items-center gap-2"
          style={{ font: "var(--text-body)", padding: "4px 0" }}
        >
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{
              background:
                sub.status === "done"
                  ? "var(--color-deal)"
                  : sub.status === "failed" || sub.status === "timeout"
                    ? "var(--color-error)"
                    : "var(--color-ink-secondary)",
            }}
          />
          <span style={{ color: "var(--color-ink)" }}>{sub.retailer}</span>
          <span style={{ color: "var(--color-ink-secondary)" }}>
            {SUBTASK_LABEL[sub.status]}
            {sub.offersFound > 0 ? ` · ${sub.offersFound} offer${sub.offersFound === 1 ? "" : "s"}` : ""}
            {sub.error ? ` — ${sub.error}` : ""}
          </span>
          {(sub.status === "failed" || sub.status === "timeout") && (
            <button
              type="button"
              onClick={() => onRetry(sub.retailer, job.jobId)}
              className="hover:underline"
              style={{ font: "var(--text-small)", color: "var(--color-primary)" }}
            >
              Retry {sub.retailer}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function OfferRow({ offer, best }: { offer: LiveOffer; best: boolean }) {
  const ago = collectedAgoLabel(offer.collectedAt);
  return (
    <li
      style={{
        border: `1px solid ${best ? "var(--color-deal)" : "var(--color-border)"}`,
        borderRadius: 8,
        padding: 12,
        marginBottom: 8,
      }}
    >
      <div className="flex items-baseline gap-2">
        <strong style={{ fontSize: 20, fontVariantNumeric: "tabular-nums" }}>
          {formatPrice(offer.price, offer.currency)}
        </strong>
        {best && (
          <span
            className="rounded px-2 py-0.5"
            style={{
              font: "var(--text-small)",
              background: "var(--color-deal-muted, var(--color-surface-muted))",
              color: "var(--color-deal)",
            }}
          >
            Best price
          </span>
        )}
        <span style={{ color: "var(--color-ink-secondary)", font: "var(--text-body)" }}>
          {offer.inStock ? "In stock" : "Out of stock"}
        </span>
      </div>
      {/* Provenance line (AC4): retailer + domain, collected-at, live/cache. */}
      <p style={{ font: "var(--text-small)", color: "var(--color-ink-secondary)", marginTop: 4 }}>
        {offer.merchant} ({offer.domain}) · collected {ago ?? "date unknown"} · {offer.method}
      </p>
      <TrackedOutboundLink
        href={offer.url}
        query=""
        rank={0}
        itemId={offer.merchant}
        className="hover:underline"
        style={{ font: "var(--text-small)", color: "var(--color-primary)" }}
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
}: {
  productId: string;
  currency: string;
}) {
  const { state, start, retryRetailer } = useCollection(productId);
  const [staleFallback, setStaleFallback] = useState<CollectJob | null>(null);
  const now = useState(() => Date.now())[0];

  // Freshness rule (AC5): auto-start a live collection on selection unless the
  // server serves a fresh cached snapshot (which arrives as a terminal state).
  useEffect(() => {
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId]);

  // Stale-cache fallback (AC6): on a failed live run with a linked previous job,
  // fetch it and render labeled cached data instead of a silent empty state.
  useEffect(() => {
    const job = state.kind === "terminal" ? state.job : null;
    if (job?.status === "failed" && job.previousJobId) {
      let cancelled = false;
      void (async () => {
        try {
          const res = await fetch(`/api/collect-jobs/${job.previousJobId}`, {
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
    }
    setStaleFallback(null);
  }, [state]);

  const phase = state as CollectionPhase;
  const job = phase.kind === "polling" || phase.kind === "terminal" ? phase.job : null;
  const bestPrice = job
    ? job.offers.length > 0
      ? Math.min(...job.offers.map((o) => o.price))
      : null
    : null;

  if (phase.kind === "idle" || phase.kind === "starting") {
    return (
      <section aria-label="Live price collection" style={{ marginTop: 16 }}>
        <p style={{ font: "var(--text-body)", color: "var(--color-ink-secondary)" }}>
          {phase.kind === "starting" ? "Starting live collection…" : "Live collection idle."}{" "}
          <button
            type="button"
            onClick={() => void start({ force: true })}
            className="hover:underline"
            style={{ font: "var(--text-body)", color: "var(--color-primary)" }}
          >
            Collect now
          </button>
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Live price collection" style={{ marginTop: 16 }}>
      {job && <ProgressHeader job={job} />}
      {job && <RetailerRows job={job} onRetry={retryRetailer} />}

      {job && job.offers.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, marginTop: 12 }}>
          {sortOffers(job.offers).map((offer) => (
            <OfferRow key={`${offer.merchant}-${offer.url}`} offer={offer} best={offer.price === bestPrice} />
          ))}
        </ul>
      )}

      {/* Full-failure error state with retry CTA (AC6) — never a silent empty state. */}
      {job && job.status === "failed" && (
        <div
          role="alert"
          style={{
            border: "1px solid var(--color-error)",
            borderRadius: 8,
            padding: 12,
            marginTop: 12,
          }}
        >
          <p style={{ font: "var(--text-body)", color: "var(--color-error)" }}>
            {job.error ?? "Collection failed"}
          </p>
          <button
            type="button"
            onClick={() => void start({ force: true })}
            className="rounded px-3 py-1.5"
            style={{
              font: "var(--text-body)",
              background: "var(--color-primary)",
              color: "#fff",
              marginTop: 8,
            }}
          >
            Retry collection
          </button>
          {staleFallback && staleFallback.offers.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <p style={{ font: "var(--text-small)", color: "var(--color-ink-secondary)" }}>
                Showing last cached results — collected{" "}
                {collectedAgoLabel(staleFallback.finishedAt ?? staleFallback.startedAt, now) ??
                  "at an unknown time"}{" "}
                (stale)
              </p>
              <ul style={{ listStyle: "none", padding: 0 }}>
                {sortOffers(staleFallback.offers).map((offer, i) => (
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

      {/* Cached snapshot served fresh (AC5): explicit "Collect again" control. */}
      {job && job.status === "complete" && job.mode === "cache" && (
        <p style={{ font: "var(--text-small)", color: "var(--color-ink-secondary)", marginTop: 8 }}>
          Cached — collected{" "}
          {collectedAgoLabel(job.finishedAt ?? job.startedAt, now) ?? "at an unknown time"} ·{" "}
          <button
            type="button"
            onClick={() => void start({ force: true })}
            className="hover:underline"
            style={{ font: "var(--text-small)", color: "var(--color-primary)" }}
          >
            Collect again
          </button>
        </p>
      )}
      {job && job.status === "complete" && job.mode === "live" && (
        <p style={{ font: "var(--text-small)", color: "var(--color-ink-secondary)", marginTop: 8 }}>
          Live results · collected{" "}
          {collectedAgoLabel(job.finishedAt ?? job.startedAt, now) ?? "just now"} ·{" "}
          <button
            type="button"
            onClick={() => void start({ force: true })}
            className="hover:underline"
            style={{ font: "var(--text-small)", color: "var(--color-primary)" }}
          >
            Collect again
          </button>
        </p>
      )}
      <p style={{ font: "var(--text-small)", color: "var(--color-ink-secondary)", marginTop: 4 }}>
        Prices in {currency}. Collection is scoped to this product only.
      </p>
    </section>
  );
}
