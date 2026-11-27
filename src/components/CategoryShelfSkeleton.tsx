/**
 * REEA-1268 — the category shelf's loading geometry. Shared by the route's
 * `loading.tsx` flash and the in-page Suspense fallback so the first paint
 * reserves the real card slots (the REEA-224 identical-markup rule) instead
 * of collapsing to a blank band while the live fan-out answers.
 */
import { SkeletonCard, StampGhost } from "@/components/SkeletonSlots";
import { getStrings, type Locale } from "@/lib/i18n";

export default function CategoryShelfSkeleton({ locale }: { locale: Locale }) {
  const t = getStrings(locale);
  return (
    <div aria-busy="true">
      <div className="pulse-bar" aria-hidden>
        <div className="pulse-bar-fill" style={{ width: "100%" }} />
      </div>
      <p className="meta-stamp" style={{ color: "var(--rc-muted)" }}>
        {t.checkingStores}
      </p>
      <StampGhost locale={locale} />
      <div className="rc-shelf">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  );
}
