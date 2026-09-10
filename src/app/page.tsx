import Link from "next/link";
import { after } from "next/server";
import type { Metadata } from "next";
import SearchForm from "@/components/SearchForm";
import { collectLiveResultsStaged } from "@/lib/collect/live-search";
import { getTrendingChips } from "@/lib/trending-chips";
import { getStrings } from "@/lib/i18n";
import { resolveRequestLocale } from "@/lib/i18n-server";

/* Design v4 "Warm Signal": full-bleed espresso hero band, ivory display type,
   ONE amber underline accent under "best price", preset-query pills, trust
   caption below. */
const EXAMPLES = ["iPhone 17 Pro", "WH-1000XM6", "Scope II keyboard"];

/**
 * REEA-448 G1 — the home <title>/description pair localizes with the session,
 * like the /results templates already do (REEA-400): the ar session reads the
 * Arabic pair instead of keeping the English one under lang="ar". One request
 * -time resolution (resolveRequestLocale: rc_locale → Accept-Language → "en"),
 * then the static table picks the pair. The layout keeps its static
 * `metadata` object as the shared fallback for the other routes (and the
 * referrer meta), so only this segment overrides — same one-export-per-
 * segment shape as src/app/results/page.tsx.
 */
export async function generateMetadata(): Promise<Metadata> {
  const locale = await resolveRequestLocale();
  const t = getStrings(locale);
  return { title: t.homeTitle, description: t.homeDescription };
}

export default async function Home() {
  // REEA-279 — hero chrome from the static table; EXAMPLES stay the real
  // query strings shoppers type, so they are content, not chrome.
  const locale = await resolveRequestLocale();
  const t = getStrings(locale);
  // REEA-542 Bet C — chip row: position 1 stays curated (the deterministic QA
  // anchor); the remaining slots come from the last-24h top queries of the
  // anonymous event feed, baked once per hour and re-baked on the hourly
  // health tick (see lib/trending-chips.ts). Below three eligible queries —
  // or on any feed failure — the row is exactly the curated EXAMPLES set.
  const chips = await getTrendingChips(EXAMPLES);
  // REEA-437 — pre-resolve every rendered chip behind the homepage response:
  // each query gets the SAME live per-query fan-out the results page runs,
  // started as the shopper reads the hero, so clicking a chip lands on warm
  // hop/discovery caches and (once the run converged) the short query-cache
  // memo instead of paying a cold start behind the first paint. No bundled
  // snapshots: every memo entry is this run's own live fetch, and the
  // per-instance memo expires with the instance — offers stay live at query
  // time. `after` keeps the chain alive behind the finished response.
  after(async () => {
    await Promise.all(chips.map((c) => collectLiveResultsStaged(c.query).allSettled));
  });
  return (
    <>
      <section className="hero-band">
        <div
          className="mx-auto w-full px-6 text-center md:text-left"
          style={{ maxWidth: "calc(var(--rc-layout-max-w) - var(--rc-gutter) * 2)" }}
        >
          <h1 className="hero-title">
            {t.heroLead} <span className="hero-accent">{t.heroAccent}</span>{t.heroTail}
          </h1>
          <p className="hero-sub mt-3 max-w-xl mx-auto md:mx-0">
            {t.heroSub}
          </p>
          <div className="mt-6">
            <SearchForm locale={locale} />
          </div>
          <div className="mt-4 flex flex-wrap justify-center md:justify-start gap-2">
            {chips.map((c) => (
              <Link key={c.query} href={`/results?q=${encodeURIComponent(c.query)}`} className="query-pill">
                {c.label}
              </Link>
            ))}
          </div>
        </div>
      </section>
      <div className="mx-auto w-full px-6" style={{ maxWidth: "var(--rc-layout-max-w)" }}>
        <p className="mt-4" style={{ font: "var(--rc-text-small)", color: "var(--rc-muted)" }}>
          {t.heroCaption}
        </p>
      </div>
    </>
  );
}
