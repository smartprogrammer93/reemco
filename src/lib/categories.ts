/**
 * REEA-1268 (Bet 1a, rank 2) — the static category registry behind the
 * shopper-facing browse surface at `/c/<slug>`.
 *
 * The shopper who knows the need but not the model ("headphones", "air fryer",
 * "washing machine", "tv") had no way into Reemco except the search box. This
 * module is the ONE static membership map: eight category slugs, the live
 * search terms each surface fans out over at query time, and a title matcher
 * that keeps a card on the shelf only when it belongs to the category.
 *
 * There is NO taxonomy service and NO CMS: the map is a source file. There is
 * also NO bundled product catalogue — every card on a `/c/<slug>` page comes
 * from the same per-retailer live fan-out the results page runs, collected in
 * the request that serves the page. A category is navigation; the merchandise
 * on it stays live.
 *
 * Client-safe on purpose (the streaming shelf component and the homepage
 * browse module both import it): no I/O, no `next/headers`, no clock read.
 */
import type { Locale } from "@/lib/i18n";

export interface CategoryLabel {
  en: string;
  ar: string;
}

export interface CategorySurface {
  /** The public route segment: `/c/<slug>`. */
  slug: string;
  label: CategoryLabel;
  /**
   * The live search terms this surface fans out over at query time. The first
   * entry is the category's own intent; the rest widen a thin live shelf with
   * adjacent terms of the SAME category (never unrelated padding). All terms
   * are plain shopper queries run through the normal live collection path.
   */
  queries: readonly string[];
  /**
   * Title membership guard. A card is only painted on the category shelf when
   * its title matches this test, so a supplementary term can never smuggle an
   * off-category product onto the surface. `null` means the seed terms' own
   * relevance gate already scopes the shelf (the pharmacy lanes answer with
   * pharmacy inventory; their titles need no keyword guard).
   */
  match: ((title: string) => boolean) | null;
  blurb: CategoryLabel;
}

const has = (re: RegExp) => (title: string) => re.test(title);

/**
 * The eight approved surfaces (REEA-1268 D-1). Order is the browse order the
 * homepage module renders; every surface is live at query time.
 *
 * Membership lines, one per slug (the ticket asks for this map in a comment):
 *   laptops             -> laptop, macbook
 *   headphones          -> headphones, airpods
 *   air-fryers          -> air fryer, philips air fryer, ninja air fryer
 *   phones              -> smartphone, iphone, samsung galaxy
 *   washing-machines    -> washing machine, washer
 *   refrigerators       -> refrigerator, fridge
 *   tv                  -> television, tv, smart tv
 *   pharmacy            -> pharmacy, medicine
 */
export const CATEGORY_SURFACES: readonly CategorySurface[] = [
  {
    slug: "laptops",
    label: { en: "Laptops", ar: "اللابتوب" },
    queries: ["laptop", "macbook"],
    match: has(/laptop|notebook|macbook|chromebook|حاسوب|لابتوب/i),
    blurb: {
      en: "Portable computers and notebooks, priced live across Kuwait retailers.",
      ar: "حواسيب محمولة ودفاتر، بأسعار مباشرة من متاجر الكويت.",
    },
  },
  {
    slug: "headphones",
    label: { en: "Headphones & earbuds", ar: "السماعات والأذنيات" },
    queries: ["headphones", "airpods"],
    match: has(/headphone|earbud|airpod|headset|سماع/i),
    blurb: {
      en: "Over-ear, on-ear and in-ear audio compared live at query time.",
      ar: "سماعات الرأس والأذنيات مقارنة مباشرة لحظة الطلب.",
    },
  },
  {
    slug: "air-fryers",
    label: { en: "Air fryers", ar: "القلايات الهوائية" },
    queries: ["air fryer", "philips air fryer", "ninja air fryer"],
    match: has(/air\s?fryer|airfryer|قلاية/i),
    blurb: {
      en: "Air fryers and multi-basket cookers, checked live across the lanes.",
      ar: "قلايات هوائية وأجهزة طهي متعددة السلال، تُفحص مباشرة عبر المتاجر.",
    },
  },
  {
    slug: "phones",
    label: { en: "Phones", ar: "الهواتف" },
    queries: ["smartphone", "iphone", "samsung galaxy"],
    match: has(
      /\bphones?\b|\biphones?\b|\bgalaxy\b|\bpixel\b|\bredmi\b|\bhonor\b|\boppo\b|\bvivo\b|\brealme\b|\boneplus\b|\bnokia\b|\binfinix\b|\btecno\b|هاتف|جوال/i,
    ),
    blurb: {
      en: "Smartphones from the local retailers, with stock and coupons live.",
      ar: "هواتف ذكية من المتاجر المحلية، مع التوافر والكوبونات مباشرة.",
    },
  },
  {
    slug: "washing-machines",
    label: { en: "Washing machines", ar: "الغسالات" },
    queries: ["washing machine", "washer"],
    // A dishwasher is not a washing machine: the "washer" term must not
    // smuggle one onto this shelf.
    match: (title) =>
      /washing\s?machine|washer|غسالة/i.test(title) && !/dishwasher/i.test(title),
    blurb: {
      en: "Washers and laundry machines compared live, not from a stored list.",
      ar: "غسالات وأجهزة غسيل مقارنة مباشرة، وليست من قائمة مخزَّنة.",
    },
  },
  {
    slug: "refrigerators",
    label: { en: "Refrigerators", ar: "الثلاجات" },
    queries: ["refrigerator", "fridge"],
    match: has(/refrigerator|fridge|ثلاجة/i),
    blurb: {
      en: "Fridges and refrigerators, live prices from the retailer lanes.",
      ar: "ثلاجات ومبردات، بأسعار مباشرة من متاجر التجزئة.",
    },
  },
  {
    slug: "tv",
    label: { en: "TVs", ar: "التلفزيونات" },
    queries: ["television", "tv", "smart tv"],
    match: has(/television|\btv\b|تلفاز|تلفزيون/i),
    blurb: {
      en: "Televisions and smart TVs compared live across the Kuwait lanes.",
      ar: "تلفزيونات وشاشات ذكية مقارنة مباشرة عبر متاجر الكويت.",
    },
  },
  {
    slug: "pharmacy",
    label: { en: "Pharmacy", ar: "الصيدلية" },
    queries: ["pharmacy", "medicine"],
    // The pharmacy lanes' own relevance gate scopes the shelf; a keyword guard
    // would drop legitimate packs whose titles never say "pharmacy".
    match: null,
    blurb: {
      en: "Everyday pharmacy packs from the pharmacy lanes, collected live.",
      ar: "منتجات الصيدلية اليومية من متاجر الصيدلية، تُجمع مباشرة.",
    },
  },
];

/** Every approved slug, in browse order. */
export const CATEGORY_SLUGS: readonly string[] = CATEGORY_SURFACES.map((c) => c.slug);

/**
 * REEA-1268 — the serializable slice of a category that a Client Component
 * may receive. `CategorySurface.match` is a function and cannot cross the
 * server→client boundary; the shelf only needs the labels and seed terms,
 * so the page hands this shape down instead of the whole registry entry.
 */
export interface CategoryShelfDef {
  slug: string;
  label: CategoryLabel;
  queries: readonly string[];
}

export function categoryShelfDef(def: CategorySurface): CategoryShelfDef {
  return { slug: def.slug, label: def.label, queries: def.queries };
}

/** Resolve a route slug to its surface; unknown slugs 404 (never a fake page). */
export function categoryBySlug(slug: string): CategorySurface | null {
  const normalized = String(slug ?? "").trim().toLowerCase();
  return CATEGORY_SURFACES.find((c) => c.slug === normalized) ?? null;
}

/** `/c/<slug>` — the one canonical category address. */
export function categoryHref(slug: string): string {
  return `/c/${slug}`;
}

/**
 * True when a card title belongs on this category's shelf. The guard is a
 * static membership test, not a ranking signal: the live collection and the
 * results shelf still decide relevance and order. A `null` matcher accepts
 * the seed terms' own primary shelf (the pharmacy lanes scope themselves).
 */
export function isCategoryMember(title: string, def: CategorySurface): boolean {
  return def.match === null ? true : def.match(title);
}

/**
 * Title-only classifier for aggregate counts (the homepage browse module).
 * A `null`-match surface is not attributable by title, so it never claims an
 * arbitrary product: its count stays 0 on a load that did not query it.
 */
export function categoryMatchesTitle(title: string, def: CategorySurface): boolean {
  return def.match === null ? false : def.match(title);
}

/* ---- Page copy (EN/AR parity; typed so a missing AR key is a build error). ---- */

export interface CategoryPageCopy {
  breadcrumbHome: string;
  breadcrumbBrowse: string;
  liveShelf: string;
  liveShelfNote: string;
  searchedLive: string;
  browseOther: string;
  showingOf: string;
  thinShelf: string;
  emptyShelf: string;
  pendingShelf: string;
  collectedLive: string;
  partialNote: string;
  cardsAria: string;
}

const enCopy: CategoryPageCopy = {
  breadcrumbHome: "Home",
  breadcrumbBrowse: "Browse",
  liveShelf: "Live shelf",
  liveShelfNote:
    "Every offer below was collected from the retailers during this request — never a stored catalogue.",
  searchedLive: "Checked live for: {terms}",
  browseOther: "Browse other categories",
  showingOf: "Showing {shown} of {available} live matches",
  thinShelf: "Only {n} live matches this load — we don't pad the shelf with unrelated items.",
  emptyShelf:
    "No live match this load. {checked} stores were checked just now — no stored catalogue is shown.",
  pendingShelf: "Still checking the stores live — offers appear as they land.",
  collectedLive: "Collected live",
  partialNote: "Some stores are still answering — this shelf shows what has landed so far.",
  cardsAria: "Category shelf cards",
};

const arCopy: CategoryPageCopy = {
  breadcrumbHome: "الرئيسية",
  breadcrumbBrowse: "تصفح",
  liveShelf: "رف مباشر",
  liveShelfNote:
    "كل عرض أدناه جُمع من المتاجر خلال هذا الطلب — وليس من كتالوج مخزَّن.",
  searchedLive: "تم الفحص المباشر لـ: {terms}",
  browseOther: "تصفح فئات أخرى",
  showingOf: "تُعرض {shown} من {available} مطابقة مباشرة",
  thinShelf: "{n} مطابقة مباشرة فقط في هذه الجولة — لا نملأ الرف بعناصر غير ذات صلة.",
  emptyShelf:
    "لا توجد مطابقة مباشرة في هذه الجولة. تم فحص {checked} متجرًا الآن — لا نعرض أي كتالوج مخزَّن.",
  pendingShelf: "ما زلنا نفحص المتاجر مباشرة — تظهر العروض فور وصولها.",
  collectedLive: "جُمعت مباشرة",
  partialNote: "بعض المتاجر لا تزال تستجيب — يعرض هذا الرف ما وصل حتى الآن.",
  cardsAria: "بطاقات رف الفئة",
};

export function categoryPageCopy(locale: Locale): CategoryPageCopy {
  return locale === "ar" ? arCopy : enCopy;
}

/**
 * Arabic/English live-card count with the locale's plural agreement. Latin
 * digits in both locales (the same rule the rest of the chrome follows).
 */
export function liveCardsLabel(locale: Locale, n: number): string {
  const count = Math.max(0, Math.floor(n));
  if (locale === "en") return count === 1 ? "1 live card" : `${count} live cards`;
  if (count === 1) return "بطاقة مباشرة واحدة";
  if (count === 2) return "بطاقتان مباشرتان";
  if (count <= 10) return `${count} بطاقات مباشرة`;
  return `${count} بطاقة مباشرة`;
}
