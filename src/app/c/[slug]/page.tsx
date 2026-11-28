import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { cookies, headers } from "next/headers";
import CategoryShelf from "@/components/CategoryShelf";
import CategoryShelfSkeleton from "@/components/CategoryShelfSkeleton";
import {
  CATEGORY_SLUGS,
  CATEGORY_SURFACES,
  categoryBySlug,
  categoryHref,
  categoryPageCopy,
  categoryShelfDef,
} from "@/lib/categories";
import { mergeCategoryStage, type CategoryStage } from "@/lib/category-shelf";
import {
  collectLiveResultsStagedAdmitted,
  type LiveSearchStages,
} from "@/lib/collect/live-search";
import { readLaneRetirement } from "@/lib/collect/lane-health";
import { readUnreachableLanes } from "@/lib/collect/zone-status";
import { MARKET_COOKIE, resolveResultsMarket } from "@/lib/country";
import { resolveRequestLocale } from "@/lib/i18n-server";
import { countryLabel } from "@/lib/results-meta";
import { fill, getStrings } from "@/lib/i18n";
import { siteOrigin } from "@/lib/site-origin";

/**
 * REEA-1268 (Bet 1a, rank 2) — the shopper-facing category browse surface.
 *
 * `/c/<slug>` is a NEW route, not a re-dressed `/results?q=`. Its shelf is a
 * live per-query retailer fan-out at request time over the static seed terms
 * in `lib/categories.ts` — no bundled catalogue and no stored snapshot is
 * presented as live. The same staged collection the results page runs feeds
 * the streamed shelf, so the first live card can paint while slower lanes are
 * still answering; the settled count/coverage line is folded over the cards
 * the page actually painted (REEA-1268 D-3).
 *
 * An unknown slug 404s. There is no fallback page: the eight approved surfaces
 * are the whole browse taxonomy, and a typo must not invent a category.
 */
type CategoryParams = Promise<{ slug: string }>;

/**
 * REEA-1268 D-2 / REEA-1189 pattern — a category surface is an indexed URL:
 * it carries a category-specific title/description in the session locale and
 * a self-referencing canonical at the one `/c/<slug>` address.
 */
export async function generateMetadata({
  params,
}: {
  params: CategoryParams;
}): Promise<Metadata> {
  const { slug } = await params;
  const def = categoryBySlug(slug);
  if (!def) return { title: "Not found — Reemco" };
  const locale = await resolveRequestLocale();
  const t = getStrings(locale);
  // Same market chain as the page body: the shopper's saved market decides
  // the localized title, never a hard-coded Kuwait claim on a Saudi view.
  const prefs = await readCategoryPrefs();
  const country = resolveResultsMarket(
    undefined,
    undefined,
    prefs.marketCookie,
    prefs.acceptLanguage,
  );
  const market = countryLabel(country, locale);
  return {
    title: fill(t.productMetaTitle, { title: def.label[locale], country: market }),
    description: fill(t.productMetaDescription, {
      title: def.label[locale],
      country: market,
    }),
    alternates: { canonical: `${siteOrigin()}/c/${def.slug}` },
  };
}

export const dynamic = "force-dynamic";
// Same live-collection headroom tier as the results/product segments
// (REEA-391): the category fan-out keeps its late hops alive behind the
// response, so the ceiling must cover the staged walk.
export const maxDuration = 45;

// REEA-1268 — the browse taxonomy is closed: the eight approved slugs are the
// whole surface, so an unknown slug must 404 instead of rendering a soft-404
// category page. The page body still runs per request (`force-dynamic`); these
// params only tell the router which segments exist.
export const dynamicParams = false;
export function generateStaticParams() {
  return CATEGORY_SLUGS.map((slug) => ({ slug }));
}

/** Request-time market preference; same chain as the results page. */
async function readCategoryPrefs(): Promise<{
  marketCookie: string | undefined;
  acceptLanguage: string | null;
}> {
  try {
    const cookieStore = await cookies();
    const headersList = await headers();
    return {
      marketCookie: cookieStore.get(MARKET_COOKIE)?.value,
      acceptLanguage: headersList.get("accept-language"),
    };
  } catch {
    return { marketCookie: undefined, acceptLanguage: null };
  }
}

export default async function CategoryPage({
  params,
}: {
  params: CategoryParams;
}) {
  const { slug } = await params;
  const def = categoryBySlug(slug);
  if (!def) notFound();
  const locale = await resolveRequestLocale();
  const copy = categoryPageCopy(locale);
  const prefs = await readCategoryPrefs();
  const country = resolveResultsMarket(
    undefined,
    undefined,
    prefs.marketCookie,
    prefs.acceptLanguage,
  );
  // Category pages do not expose the stock toggle; the default view hides
  // out-of-stock rows exactly like the results page's default.
  const showOutOfStock = false;
  // eslint-disable-next-line react-hooks/purity -- intentional single clock read per server render (REEA-283 pattern); hydration reuses the serialized value.
  const renderStartMs = Date.now();

  // REEA-1078 S2/AC9 — the category fan-out obeys the same retired-lane and
  // unreachable-lane reads as every other serve path.
  const [retirement, unreachableLanes] = await Promise.all([
    readLaneRetirement(),
    readUnreachableLanes(),
  ]);

  // The live fan-out starts here, one admitted staged run per seed term, in
  // parallel. Each run is the SAME collection path the results page uses; a
  // run that cannot be admitted serves its honest pending shell instead of
  // multiplying the retailer lanes.
  const runs = await Promise.all(
    def.queries.map(async (term) => {
      try {
        const stages = await collectLiveResultsStagedAdmitted(term, {
          locale,
          retiredLanes: retirement.retired,
          readmittedLanes: retirement.readmitted,
        });
        return { term, stages };
      } catch {
        return { term, stages: null as LiveSearchStages | null };
      }
    }),
  );

  // One merged category flush per adapter-arrival stage. The final flush
  // reads every term's finalized snapshot, so the settled count line speaks
  // for the whole run rather than for the first term that happened to land.
  const maxStages = runs.reduce(
    (max, run) => Math.max(max, run.stages?.stages.length ?? 0),
    0,
  );
  const stages: Promise<CategoryStage>[] = [];
  for (let index = 0; index < maxStages; index += 1) {
    const final = index === maxStages - 1;
    stages.push(
      Promise.all(
        runs.map(async (run) => {
          const promise = final ? run.stages?.final : run.stages?.stages[index];
          if (!promise) return { term: run.term, snap: null };
          try {
            return { term: run.term, snap: await promise };
          } catch {
            return { term: run.term, snap: null };
          }
        }),
      ).then((parts) =>
        mergeCategoryStage(
          parts,
          def,
          country,
          showOutOfStock,
          def.queries.length,
        ),
      ),
    );
  }

  // Keep the hops still in flight alive behind the finished response so the
  // run's converged answer lands in the memo for the next request.
  after(async () => {
    await Promise.all(
      runs.map(async (run) => {
        if (!run.stages) return;
        try {
          await run.stages.allSettled;
        } catch {
          // A rejected tail must never surface as a failed render.
        }
      }),
    );
  });

  const [termsBefore, termsAfter] = copy.searchedLive.split("{terms}");
  return (
    <div
      className="category-viewport-reserve mx-auto w-full py-6"
      style={{
        maxWidth: "var(--rc-layout-max-w)",
        paddingInline: "var(--rc-gutter)",
      }}
    >
      <nav aria-label={copy.breadcrumbBrowse} className="rc-cat-crumb">
        <Link href="/">{copy.breadcrumbHome}</Link>
        <span aria-hidden>/</span>
        <span>{copy.breadcrumbBrowse}</span>
        <span aria-hidden>/</span>
        <bdi>{def.label[locale]}</bdi>
      </nav>
      <header className="rc-cat-hero">
        <p className="rc-cat-kicker">
          <span className="rc-pulse" aria-hidden />
          {copy.liveShelf}
        </p>
        <h1>{def.label[locale]}</h1>
        <p className="rc-cat-blurb">{def.blurb[locale]}</p>
        <p className="rc-cat-live-note">{copy.liveShelfNote}</p>
        <p className="rc-cat-terms">
          {termsBefore}
          <bdi className="lat">{def.queries.join(" · ")}</bdi>
          {termsAfter}
        </p>
      </header>
      {stages.length > 0 ? (
        <Suspense fallback={<CategoryShelfSkeleton locale={locale} />}>
          <CategoryShelf
            stages={stages}
            def={categoryShelfDef(def)}
            country={country}
            locale={locale}
            renderStartMs={renderStartMs}
            shareOrigin={siteOrigin()}
            unreachableLanes={unreachableLanes}
          />
        </Suspense>
      ) : (
        <p className="rc-cat-count-line" role="status">
          {fill(copy.emptyShelf, { checked: 0 })}
        </p>
      )}
      <nav aria-label={copy.browseOther} className="rc-cat-other">
        <h2>{copy.browseOther}</h2>
        <ul>
          {CATEGORY_SURFACES.filter((c) => c.slug !== def.slug).map((c) => (
            <li key={c.slug}>
              <Link href={categoryHref(c.slug)}>{c.label[locale]}</Link>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
