import { Suspense } from "react";
import Link from "next/link";
import { after } from "next/server";
import type { Metadata } from "next";
import SearchForm from "@/components/SearchForm";
import HomeDiscoveryModules, { HomeDiscoverySkeleton } from "@/components/HomeDiscoveryModules";
import { collectLiveResultsStagedAdmitted } from "@/lib/collect/live-search";
import { collectHomeDiscovery } from "@/lib/collect/home-discovery";
// REEA-1078 S2 — dead-lane retirement for the chip pre-warm fan-outs.
import { readRetiredLanes } from "@/lib/collect/lane-health";
import { getTrendingChips } from "@/lib/trending-chips";
import { getStrings } from "@/lib/i18n";
import { resolveRequestLocale } from "@/lib/i18n-server";

/* Direction A "Shelf" home (REEA-1055 §3, REEA-1069): espresso hero with ONE
   search, then live discovery modules. Every module is populated from the
   same per-query live fan-out the results page runs — no bundled catalogue
   presented as live data. */
const EXAMPLES = ["iPhone 17 Pro", "WH-1000XM6", "Scope II keyboard"];

/**
 * REEA-448 G1 — the home <title>/description pair localizes with the session,
 * like the /results templates already do (REEA-400): the ar session reads the
 * Arabic pair instead of keeping the English one under lang="ar".
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
  // anchor); the remaining slots come from the last-24h top queries.
  const chips = await getTrendingChips(EXAMPLES);
  // REEA-437 — pre-resolve every rendered chip behind the homepage response:
  // each query gets the SAME live per-query fan-out the results page runs,
  // started as the shopper reads the hero, so clicking a chip lands on warm
  // hop/discovery caches and (once the run converged) the short query-cache
  // memo instead of paying a cold start behind the first paint. No bundled
  // snapshots: every memo entry is this run's own live fetch, and the
  // per-instance memo expires with the instance — offers stay live at query
  // time. `after` keeps the chain alive behind the finished response.
  //
  // REEA-1070 AC1 — those SAME runs are the live source for the home
  // discovery modules below (retailer strip, price drops, categories, method
  // band). One fan-out per rendered query feeds both the warm cache and the
  // modules; no bundled catalogue and no second round of retailer requests.
  // REEA-1078 S2 — the pre-warm runs obey the same dead-lane retirement set
  // as the results page; a store failure fails open (static retirement only).
  // REEA-1133 — the home pre-warm is a page-path fan-out too (three queries =
  // three ~15-lane runs per render), so it takes the same bounded FAIL-CLOSED
  // admission as /results. A denied run resolves immediately with the honest
  // pending shell and is deferred behind the response instead of multiplying
  // the retailer lanes; the modules then render their no-response state rather
  // than inventing merchandise.
  const retiredLanes = await readRetiredLanes();
  const runs = await Promise.all(
    chips.map(async (c) => ({
      query: c.query,
      stages: await collectLiveResultsStagedAdmitted(c.query, { retiredLanes }),
    })),
  );
  const discovery = collectHomeDiscovery(runs);
  after(async () => {
    await Promise.all(runs.map((r) => r.stages.allSettled));
  });
  return (
    <>
      <section className="rc-hero">
        <div className="rc-hero-inner">
          <h1>
            {t.heroLead} <span className="hero-accent">{t.heroAccent}</span>
            {t.heroTail}
          </h1>
          <p className="lead">{t.heroSub}</p>
          <SearchForm variant="hero" locale={locale} />
          <div className="rc-suggestions">
            {chips.map((c) => (
              <Link key={c.query} href={`/results?q=${encodeURIComponent(c.query)}`} className="rc-suggestion">
                <bdi>{c.label}</bdi>
              </Link>
            ))}
          </div>
        </div>
      </section>
      <div className="mx-auto w-full" style={{ maxWidth: "var(--rc-layout-max-w)", paddingInline: "var(--rc-gutter)" }}>
        <p className="rc-home-caption">{t.heroCaption}</p>
        {/* REEA-1070 AC1 — the live discovery modules stream in behind the
            hero. The fallback is the loading state; the resolved data carries
            live / empty / no-response per module so the UI never invents
            merchandise. */}
        <Suspense fallback={<HomeDiscoverySkeleton locale={locale} />}>
          <HomeDiscoveryModules discovery={discovery} locale={locale} />
        </Suspense>
      </div>
    </>
  );
}
