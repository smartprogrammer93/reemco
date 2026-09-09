import Link from "next/link";
import { after } from "next/server";
import SearchForm from "@/components/SearchForm";
import { collectLiveResultsStaged } from "@/lib/collect/live-search";
import { getStrings } from "@/lib/i18n";
import { resolveRequestLocale } from "@/lib/i18n-server";

/* Design v4 "Warm Signal": full-bleed espresso hero band, ivory display type,
   ONE amber underline accent under "best price", preset-query pills, trust
   caption below. */
const EXAMPLES = ["iPhone 17 Pro", "WH-1000XM6", "Scope II keyboard"];

export default async function Home() {
  // REEA-279 — hero chrome from the static table; EXAMPLES stay the real
  // query strings shoppers type, so they are content, not chrome.
  const locale = await resolveRequestLocale();
  const t = getStrings(locale);
  // REEA-437 — pre-resolve the curated example chips behind the homepage
  // response: each example gets the SAME live per-query fan-out the results
  // page runs, started as the shopper reads the hero, so clicking a chip
  // lands on warm hop/discovery caches and (once the run converged) the short
  // query-cache memo instead of paying a cold start behind the first paint.
  // No bundled snapshots: every memo entry is this run's own live fetch, and
  // the per-instance memo expires with the instance — offers stay live at
  // query time. `after` keeps the chain alive behind the finished response.
  after(async () => {
    await Promise.all(EXAMPLES.map((q) => collectLiveResultsStaged(q).allSettled));
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
            {EXAMPLES.map((q) => (
              <Link key={q} href={`/results?q=${encodeURIComponent(q)}`} className="query-pill">
                {q}
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
