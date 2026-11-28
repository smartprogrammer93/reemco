"use client";

/**
 * REEA-1268 — the streamed shopper shelf for a `/c/<slug>` category surface.
 *
 * The server starts the category's live per-term fan-out and hands this
 * component one merged flush promise per adapter-arrival stage. Each flush
 * paints only the cards not already painted by an earlier flush (cumulative
 * productId baseline, the same REEA-1141 rule the results shelf uses), capped
 * at the category budget, so the first price can paint while slower lanes are
 * still in flight and the settled page never repeats a card.
 *
 * Honesty (REEA-1268 D-3): the count/coverage line is rendered on the FINAL
 * flush from the cards this component actually painted, not from the payload
 * it could have painted. "N live cards" equals the cards above it; the
 * coverage sentence's "M carry this" is folded over those same painted cards,
 * and a zero shelf says "none carry this" instead of inventing a carrier.
 *
 * Hydration safety: every humanised timestamp is derived from the server's
 * baked `renderStartMs` and the snapshot's own collectedAt stamp — this
 * component never reads Date.now() during render.
 */
import { Suspense, use, type ReactNode } from "react";
import ProductResultCard from "@/components/ProductResultCard";
import { coverageParts, type CoveragePart } from "@/lib/collect/coverage";
import {
  categoryPageCopy,
  liveCardsLabel,
  type CategoryShelfDef,
} from "@/lib/categories";
import { CATEGORY_SHELF_CARDS, freshCardsForFlush, paintedIdsAfter } from "@/lib/results-shelf";
import { fill, getStrings, type Locale } from "@/lib/i18n";
import { localizedAgeFor } from "@/lib/relative-time";
import type { CountryCode } from "@/lib/country";
import type { CategoryStage } from "@/lib/category-shelf";
import type { NormalizedProduct } from "@/types/product";

const EMPTY_PAINTED_IDS: ReadonlySet<string> = new Set<string>();
const EMPTY_PAINTED_CARDS: readonly NormalizedProduct[] = [];

export interface CategoryShelfProps {
  /** One merged category flush per stage; the server builds these promises. */
  stages: Promise<CategoryStage>[];
  def: CategoryShelfDef;
  country: CountryCode | null;
  locale: Locale;
  /** One baked server clock for every humanised timestamp on this page. */
  renderStartMs: number;
  shareOrigin?: string;
  /** Lanes the reachability record names as blocked from this egress. */
  unreachableLanes?: readonly string[];
}

function namesText(names: string[], ar: boolean): string {
  const max = 3;
  const shown = names.length > max ? names.slice(0, max) : names;
  const rest = names.length - shown.length;
  if (ar) {
    return `${shown.join(" و")}${rest > 0 ? ` و${rest} أخرى` : ""}`;
  }
  const joined =
    shown.length <= 1
      ? shown.join("")
      : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
  return `${joined}${rest > 0 ? ` and ${rest} more` : ""}`;
}

/** Render the shared coverage sentence with isolated Latin retailer names. */
function CoverageSentence({ parts }: { parts: CoveragePart[] }) {
  const out: ReactNode[] = [];
  parts.forEach((p, i) => {
    if (p.kind === "text") out.push(<span key={`t-${i}`}>{p.value}</span>);
    else
      out.push(
        <bdi key={`n-${i}`} className="lat">
          {namesText(p.names, p.ar)}
        </bdi>,
      );
  });
  return <>{out}</>;
}

/**
 * The settled count/coverage line. It reads ONLY the cards this shelf painted
 * (threaded down the flush chain), so rendered == payload by construction.
 */
function CategorySummary({
  stage,
  paintedCards,
  def,
  locale,
  renderStartMs,
  unreachableLanes,
}: {
  stage: CategoryStage;
  paintedCards: readonly NormalizedProduct[];
  def: CategoryShelfDef;
  locale: Locale;
  renderStartMs: number;
  unreachableLanes?: readonly string[];
}) {
  const copy = categoryPageCopy(locale);
  const painted = paintedCards.length;
  const available = stage.cards.length;
  const checked = stage.notes.length;
  const age =
    stage.collectedAtEpochMs != null
      ? localizedAgeFor(locale, stage.collectedAtEpochMs, renderStartMs)
      : null;
  // The aggregate sentence reads the painted cards: "M carry this" can never
  // exceed what is on screen, and a zero shelf reads "none carry this".
  const parts = coverageParts(
    stage.notes,
    locale,
    paintedCards,
    unreachableLanes,
    def.queries[0],
    painted === 0,
  );
  return (
    <div className="rc-cat-summary">
      {painted === 0 ? (
        <p className="rc-cat-count-line" role="status">
          {stage.settled ? fill(copy.emptyShelf, { checked }) : copy.pendingShelf}
        </p>
      ) : (
        <p className="rc-cat-count-line" role="status" data-category-shelf-cards={painted}>
          <bdi className="tabular">{liveCardsLabel(locale, painted)}</bdi>
          {available > painted ? (
            <>{" · "}{fill(copy.showingOf, { shown: painted, available })}</>
          ) : null}
          {age ? <>{" · "}{copy.collectedLive} <bdi>{age}</bdi></> : null}
        </p>
      )}
      {painted > 0 && painted < CATEGORY_SHELF_CARDS && stage.settled ? (
        <p className="rc-cat-thin">{fill(copy.thinShelf, { n: painted })}</p>
      ) : null}
      {parts.length > 0 ? (
        <p className="rc-cat-coverage">
          <CoverageSentence parts={parts} />
        </p>
      ) : null}
      {stage.partial && painted > 0 ? (
        <p className="rc-cat-partial">{copy.partialNote}</p>
      ) : null}
    </div>
  );
}

/** Reserve the remaining shelf slots while later lanes are still answering. */
function ShelfGhost({ slots }: { slots: number }) {
  return (
    <div className="rc-shelf" aria-hidden>
      {Array.from({ length: Math.max(0, slots) }).map((_, i) => (
        <div className="skeleton-card" key={i}>
          <div className="skeleton-block w-2/3" />
          <div className="skeleton-block mt-2 w-1/3" />
          <div className="skeleton-block mt-4 w-32" />
        </div>
      ))}
    </div>
  );
}

function CategoryStageAppend(props: {
  stages: Promise<CategoryStage>[];
  index: number;
  def: CategoryShelfDef;
  country: CountryCode | null;
  locale: Locale;
  renderStartMs: number;
  shareOrigin?: string;
  unreachableLanes?: readonly string[];
  paintedIds: ReadonlySet<string>;
  paintedCards: readonly NormalizedProduct[];
}) {
  const snap = use(props.stages[props.index]);
  const { locale, country } = props;
  // Plain append policy (no comparison-first): a browse shelf is judged on
  // its live depth, so every category card may claim a slot as it lands.
  const fresh = freshCardsForFlush(
    snap.cards,
    props.paintedIds,
    false,
    CATEGORY_SHELF_CARDS,
  );
  const nextPaintedIds = paintedIdsAfter(props.paintedIds, fresh);
  const nextPaintedCards = fresh.length
    ? [...props.paintedCards, ...fresh]
    : props.paintedCards;
  const isFinal = props.index === props.stages.length - 1;
  const next = !isFinal ? (
    <Suspense
      fallback={
        <ShelfGhost slots={Math.max(0, CATEGORY_SHELF_CARDS - nextPaintedIds.size)} />
      }
    >
      <CategoryStageAppend
        {...props}
        index={props.index + 1}
        paintedIds={nextPaintedIds}
        paintedCards={nextPaintedCards}
      />
    </Suspense>
  ) : null;
  return (
    <>
      {fresh.length > 0 ? (
        <div className="rc-shelf rc-cat-shelf">
          {fresh.map((p, i) => (
            <ProductResultCard
              key={p.productId}
              product={p}
              // The first painted card is the cheapest live card this shelf
              // could offer at that moment (the results page's same badge rule).
              isBest={props.paintedCards.length === 0 && i === 0}
              kuwaitBatchPending={!snap.settled}
              kuwaitPendingStatus={false}
              query={props.def.queries[0]}
              rank={props.paintedCards.length + i}
              country={country}
              showOutOfStock={false}
              locale={locale}
              renderStartMs={props.renderStartMs}
              cascadeIndex={props.paintedCards.length + i}
              shareOrigin={props.shareOrigin}
            />
          ))}
        </div>
      ) : null}
      {isFinal ? (
        <CategorySummary
          stage={snap}
          paintedCards={nextPaintedCards}
          def={props.def}
          locale={locale}
          renderStartMs={props.renderStartMs}
          unreachableLanes={props.unreachableLanes}
        />
      ) : null}
      {next}
    </>
  );
}

export default function CategoryShelf(props: CategoryShelfProps) {
  return (
    <section aria-label={getStrings(props.locale).primaryResultsAria} data-primary-section="true">
      <CategoryStageAppend
        stages={props.stages}
        index={0}
        def={props.def}
        country={props.country}
        locale={props.locale}
        renderStartMs={props.renderStartMs}
        shareOrigin={props.shareOrigin}
        unreachableLanes={props.unreachableLanes}
        paintedIds={EMPTY_PAINTED_IDS}
        paintedCards={EMPTY_PAINTED_CARDS}
      />
    </section>
  );
}
