/**
 * REEA-1268 — the `/c/<slug>` navigation flash. It reserves the category
 * heading and the six live-card slots (the same CategoryShelfSkeleton the
 * in-page Suspense boundary uses) so a category navigation never paints a
 * blank band before the live fan-out answers.
 */
import CategoryShelfSkeleton from "@/components/CategoryShelfSkeleton";
import { HeadingGhost } from "@/components/SkeletonSlots";
import { resolveRequestLocale } from "@/lib/i18n-server";

export default async function CategoryLoading() {
  const locale = await resolveRequestLocale();
  return (
    <div
      className="category-viewport-reserve mx-auto w-full py-6"
      style={{
        maxWidth: "var(--rc-layout-max-w)",
        paddingInline: "var(--rc-gutter)",
      }}
    >
      <HeadingGhost />
      <CategoryShelfSkeleton locale={locale} />
    </div>
  );
}
