/**
 * REEA-279 — EN/AR chrome for the Arabic-first Kuwait market.
 *
 * A STATIC string table only: every chrome string is a literal in both
 * languages, chosen at render time by `getStrings`. No machine-translation
 * step ever runs in the query path — the shopper's query, the retailer fan-out
 * and the Arabic title matching are untouched by this module (matching Arabic
 * retailer titles already works via the query itself).
 *
 * Persistence follows the app's existing preference mechanism (REEA-280
 * pattern in country.ts): the choice lives in ONE cookie (`rc_locale`), nothing
 * else — no profile, no fingerprint, no extra storage. Resolution order is the
 * same chain everywhere (REEA-448 order): cookie → coarse Accept-Language
 * hint → Arabic-script query text → "en". The hint
 * is coarse on purpose (only the ar/en language subtag decides; language-only
 * tags map directly, regions are ignored) — guessing beyond the stated browser
 * language would be profiling, not a hint.
 *
 * Hydration contract: server components resolve the locale from the request's
 * cookie/header (resolveRequestLocale) and PASS IT DOWN as a prop; client
 * components render from that prop when present, so the first paint and the
 * hydration pass always agree. The client-side chain (clientLocale) is the
 * fallback for hosts without server resolution (static export, tests).
 *
 * This module stays importable by CLIENT components, so it carries no
 * `next/headers` import — request-time reads live next to the Server
 * Components that use them (see src/lib/i18n-server.ts).
 */

import { COVERAGE_ORDER } from "./collect/coverage";

export type Locale = "en" | "ar";

/** The single language-preference cookie. No other persistent storage. */
export const LOCALE_COOKIE = "rc_locale";
/** A year: a deliberate language choice outlives the session it was made in. */
const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/* ---- The static string table. -------------------------------------------
   `ar` is typed against the `en` shape, so a missing AR key is a compile
   error, not a silent English fallback. Placeholders: {q} query, {n} count,
   {x} retailer name, {cur} currency code — fill() substitutes them. */

const en = {
  toggleLabel: "العربية",
  toggleAria: "Switch language",
  searchPlaceholder: "Search for a product…",
  searchLabel: "Search for a product",
  searchButton: "Search",
  refresh: "Refresh",
  footerAbout: "About",
  footerPrivacy: "Privacy",
  footerContact: "Contact",
  footerNav: "Footer",
  footerDisclosure:
    "Reemco earns affiliate commissions from some retailer links. This never affects the ranking you see — best effective price always wins.",
  filterCountryAria: "Filter offers by country",
  filterAll: "All",
  countryKW: "Kuwait",
  countrySA: "Saudi Arabia",
  countryEG: "Egypt",
  showOutOfStock: "Show out-of-stock items",
  inStock: "In stock",
  outOfStock: "Out of stock",
  bestPrice: "Best price",
  // REEA-835 — honest first paint: while the Kuwait retailer batch is still
  // pending, the lead card's flag slot carries this checking state instead of
  // an unqualified "Best price" (an interim international price must never
  // read as a Kuwait best price). Count-free on purpose: the shopper-visible
  // claim stays true whether 0 or 24 Kuwait adapters have answered so far.
  kuwaitChecking: "Checking Kuwait stores…",
  lowestListed: "Lowest listed price",
  // REEA-963 R1 FR-1.3 — the sanity warning affordance: flagged offers stay
  // visible but never read as trustworthy. The badge label is short (inline
  // chip, designer brief: must NOT look like an error state); the per-reason
  // explanation rides the native title attribute (one hover/tap away).
  priceVerifyBadge: "Price needs verification",
  // REEA-1178 AC3 — the possible-mismatch marker on an offer row whose figure
  // is not comparable evidence for this card (flagged, or below a tenth of the
  // cohort median). Short chip text, reason sentence in the title attribute.
  mismatchBadge: "Possible mismatch",
  priceUnavailable: "Price unavailable",
  verifyOutlier:
    "This figure is far from the typical price for this search, so it may not be comparable.",
  verifyCurrency:
    "The currency on this listing could not be verified, so the figure may be misstated.",
  verifyNoPrice: "The retailer served no usable price for this listing.",
  saveLead: "Save",
  effectiveLead: "Effective",
  effectiveTail: "with coupon",
  // REEA-657 Bet 2 (§5.4 chip, accepted spec criterion b): the amber chip
  // text LEADS with the word Coupon — an amount-only badge reads as a second
  // price next to the real one. "Coupon KD 5" / كوبون KD 5.
  couponLead: "Coupon",
  // REEA-760 coupon honesty line (spec eb16258c, ACCEPT REEA-748): chip = code
  // verbatim, else the exact one-step auto-note; attribution + effective lead
  // ride the same locale path as every other chrome string. Latin codes render
  // as-is in both locales.
  couponAutoNote: "auto-applied at checkout",
  couponViaLead: "via",
  couponEffectiveLead: "Effective",
  // REEA-1177 AC 6a-2/6a-6 — the one reconciling price statement: listed −
  // appliedDiscount = effective, or "up to …" when the applied value is
  // conditional and unknown. Figures ride the shared formatter.
  compositionListed: "Listed",
  compositionListedOnly: "Listed {listed} · final price shown at checkout",
  compositionMath: "Listed {listed} − {discount} = You pay {effective}",
  couponAppliedAtCheckout: "Coupon {x} off at checkout",
  couponUpTo: "up to {x} off at checkout",
  // REEA-540 Bet A — confidence-line pair on results cards:
  // "Seen recently: KD 4,099–KD 4,350 · last 14 days".
  seenRecentlyLead: "Seen recently:",
  seenRecentlyWindow: "last 14 days",
  // REEA-1167 — a single scoped observation is honest on its own:
  // "First seen: KD 94.95" (no 14-day window claim).
  firstSeenLead: "First seen:",
  viewAtLead: "View at",
  goToStore: "Go to store",
  // REEA-930 scope 1 — freshness-anchored offer CTA. The age ladder mirrors
  // relativeAge's s/m/h/d buckets but localizes the COPY (the CTA is
  // shopper-facing prose, not the ASCII figure/label space prices ride —
  // REEA-488); the digits themselves stay Latin in both locales, same as
  // freshUpdatedMinutes AR. ctaCheckedLead + localizedAge compose
  // "Checked 12s ago · Xcite" / "تم التحقق قبل 12ث · اكسترا".
  ctaCheckedLead: "Checked",
  ageSec: "{n}s ago",
  ageMin: "{n}m ago",
  ageHour: "{n}h ago",
  ageDay: "{n}d ago",
  // REEA-930 scope 2 — lead-card primary CTA decision line:
  // "Best effective price KD 42.90 → Xcite"; when the figure folds a coupon
  // the existing effectiveTail ("with coupon" / "بالكوبون") names the basis.
  // The arrow flips with the reading direction, matching viewAtRetailer's ←.
  ctaBestLead: "Best effective price",
  ctaArrow: "→",
  pricesSectionAria: "Prices and availability by retailer",
  pricesHeading: "Prices at retailers · excl. delivery",
  colourOptionsAria: "Colour options",
  variationsLabel: "Variations",
  // REEA-836 AC3 — disclosure label above the untouched retailer title string.
  originalTitleLabel: "Original retailer title",
  alternativesLabel: "Alternatives",
  pairsWithLabel: "Pairs with",
  devicesLabel: "Devices",
  accessoriesLabel: "Accessories",
  retailersOne: "retailer",
  retailersMany: "retailers",
  fromWord: "from",
  offerOne: "offer",
  offerMany: "offers",
  storesWord: "stores",
  timedOut: "Timed out",
  failedLabel: "Failed",
  retry: "Retry",
  retryCollection: "Retry collection",
  collectNow: "Collect now",
  collectAgain: "Collect again",
  startingLive: "Starting live collection…",
  idleLive: "Live collection idle.",
  liveCollectionAria: "Live price collection",
  collectingAria: "Collecting live offers",
  checkingStores: "Checking live stores…",
  checkingStore: "Checking {x}…",
  collectionComplete: "Collection complete",
  collectionFailed: "Collection failed",
  pricesInLead: "Prices in",
  pricesInTail: ". Collection is scoped to this product only.",
  viewAtRetailer: "View at retailer →",
  cachedLead: "Cached — refreshed at",
  showingCachedLead: "Showing last cached results — collected",
  staleNote: "(stale)",
  liveResultsLead: "Live results · collected",
  collectedWord: "collected",
  dateUnknown: "date unknown",
  justNow: "just now",
  liveWord: "live",
  cachedWord: "cached",
  updatedWord: "updated",
  freshUpdatedMinutes: "Updated {n} minutes ago",
  freshUpdatedMinute: "Updated 1 minute ago",
  freshJustNow: "Updated just now",
  freshUnknown: "Updated date unknown",
  staleSuffix: " · may be outdated",
  staleTitle: "Last verified more than 7 days ago — the price may be outdated.",
  copyLabel: "Copy",
  copyAriaLead: "Copy coupon code",
  // REEA-541 Bet B — share-summary line: lead word before the offer list, the
  // verified word before the freshness bucket label (buildShareSummary).
  shareSummaryAria: "Copy price comparison summary",
  shareBestNowLead: "best now",
  shareVerifiedWord: "verified",
  couponMoreSuffix: "more",
  couponNoneLabel: "No coupon available",
  errorTitle: "Something went wrong",
  errorBody:
    "We couldn't finish loading this page. Check your connection and try again — your search stays put.",
  errorBodyShort: "We couldn't load the results. Check your connection and try again.",
  notFoundTitle: "Page not found",
  notFoundBody:
    "The page you were looking for doesn't exist. Try one of these searches:",
  // REEA-964 FR-1.1 — the empty-state copy is SPEC-PINNED: heading exactly
  // "No match found" (do not reword without PM sign-off), sub-line suggesting
  // rephrasing, then the three editorially chosen example queries (FR-1.1)
  // rendered as pills. The failed query itself lives in the pre-filled retry
  // input (FR-1.2), not in the heading.
  emptyTitle: "No match found",
  emptyBody: "Check the spelling or try a broader search term.",
  // REEA-1114 AC1/AC2 — the filter-aware empty state. A zero visible set
  // that an ACTIVE filter hid is not a no-match: name the filter, the count
  // and the one-tap reveal instead of blaming the spelling. `{filter}` is the
  // same label the chip carries ("In stock" / the market name).
  emptyHiddenTitle: "{n} {unit} hidden by {filter}",
  matchOne: "match",
  matchMany: "matches",
  emptyHiddenBody:
    "We found them in the live results just now — the {filter} filter is hiding them. Your search stays as it is.",
  emptyShowOutOfStock: "Show out-of-stock",
  emptyShowAllCountries: "Show all countries",
  // REEA-1114 AC3 — the chip count. The full phrase reads at desktop widths;
  // at 375 the CSS keeps the count badge and drops the word so the 3-per-row
  // 44px filter grid never clips (AC5).
  chipHiddenWord: "hidden",
  chipHiddenAria: "{n} hidden by this filter",
  // FR-1.1 — the three static example product queries (editorially chosen).
  emptyExample1: "iPhone",
  emptyExample2: "Dyson vacuum",
  emptyExample3: "Kindle",
  // FR-1.3 / E6 — the related band under the empty state, and the honest
  // "stores didn't answer" variant (never imply a no-match on an outage).
  relatedNotExactLabel: "Related items — not an exact match",
  relatedChip: "Related",
  // FR-2.1 — the primary section's own DOM landmark, so the two-section
  // separation is machine-checkable (distinct section role/heading).
  primaryResultsAria: "Primary results",
  emptyUnavailable:
    "The stores didn't answer this time — results are temporarily unavailable. Please try again shortly.",
  // REEA-1096 D11 — when collection failed there is no match to claim: the
  // outage gets its own heading instead of "No match found" plus the outage
  // line in the same card.
  emptyUnavailableTitle: "The stores didn’t answer this time",
  // REEA-332: the one hint line under the count heading when the answer is empty.
  emptyHint: "No matches — try a shorter phrase.",
  // REEA-437 AC-2: the empty state names the query forms the live run tried.
  triedForms: "We searched “{tries}”.",
  resultsOne: "result",
  resultsMany: "results",
  resultsForWord: "for",
  allProducts: "all products",
  heroLead: "Find the real",
  heroAccent: "best price",
  heroTail: ".",
  heroSub:
    "Prices, coupons and stock, collected live from every retailer the moment you open a product — compared honestly, never from a stale snapshot.",
  heroCaption:
    "Live collection starts as soon as you pick a product — first offers usually land within half a second, and every price shows when it was collected and by whom.",
  allOffersLead: "← All offers for this product",
  aboutTitle: "About Reemco",
  aboutWhatLabel: "WHAT WE DO",
  aboutWhatBody:
    "Reemco is a price-comparison site for shopping in Kuwait. Search one product and see its price, stock, coupons and cheaper alternatives across retailers in one list. Kuwait-first; KSA and Egypt as secondary.",
  aboutWhoLabel: "WHO WE COMPARE",
  // REEA-468 G4 — the About list IS the live adapter roster: derived from the
  // shared COVERAGE_ORDER (pinned to COLLECTORS by live-search.test.ts) so it
  // equals the merchants that actually answer result pages, and a new adapter
  // batch cannot leave this string behind again.
  aboutWhoBody: `${COVERAGE_ORDER.join(" · ")}.`,
  aboutFreshLabel: "HOW FRESH PRICES ARE",
  aboutFreshBody:
    "Offers are fetched live from each retailer the moment you search, not from a stale snapshot. Every result shows when its price was collected.",
  privacyTitle: "Privacy",
  privacyLead: "In plain language: what Reemco records, and why.",
  privacyRecordLabel: "WHAT WE RECORD",
  privacyRecordBody:
    "Which product was searched, which offers were opened, and which retailer link was clicked. Records are anonymous counts and click-outs — no names, no personal profiles.",
  privacyWhyLabel: "WHY",
  privacyWhyBody:
    "It tells us which searches return good matches and where our results need fixing.",
  privacyLeaveLabel: "WHEN YOU LEAVE",
  privacyLeaveBody:
    "Clicking through opens the retailer's own site. From that click on, the retailer's own privacy policy applies.",
  contactTitle: "Contact",
  contactLead: "Questions, corrections, or a retailer we should add? Email us.",
  contactReply: "We aim to reply within one business day.",
  contactInclude: "Include the product name and the retailer you saw.",
  // REEA-400 — per-query results-page metadata: the title carries the query so
  // each query becomes its own indexed landing surface. {q} query, {country}
  // resolved market label; empty queries substitute allProducts for {q}.
  metaTitle: "{q} prices in {country} - Reemco",
  metaDescription:
    "Compare live prices, coupons and stock for {q} across retailers in {country}. Offers are collected the moment you search — best effective price wins.",
  // REEA-1168 — Product/Offer JSON-LD copy. {title} product, {country} market,
  // {n} fresh offers, {price}/{cur} cheapest claimable offer. The EN name is
  // the retailer's own product title; the AR name carries the localized
  // "prices in <market>" phrase so the Arabic page emits Arabic structured
  // data instead of an English-only name.
  jsonLdProductName: "{title}",
  jsonLdProductDescription:
    "Live prices for {title} in {country}: {n} retailer offers, starting at {price} {cur}.",
  // REEA-1069 — Direction A "Shelf" chrome (design pack REEA-1055).
  brandHomeAria: "Reemco home",
  menuLabel: "Menu",
  menuClose: "Close menu",
  menuHowCompare: "How we compare",
  toggleAriaTo: "Switch language to {lang}",
  // REEA-1159 — the theme control's accessible name is the STATE ("Dark mode"
  // + aria-pressed), not the action, so a screen reader announces "Dark mode,
  // toggle button, pressed / not pressed" instead of a label that flips under
  // the user. The action hint rides `title` for sighted hover.
  themeLabel: "Dark mode",
  themeToggleTo: "Switch to {theme} theme",
  themeLight: "light",
  themeDark: "dark",
  filterAria: "Filters and market",
  filterSaudi: "Saudi",
  resultsHeading: "{q} prices in {country}",
  resultsHeadingAll: "All products prices in {country}",
  resultsSubline: "{n} {unit} for “{q}” · {offers} retailer offers · collected live {age}",
  productsWord: "products",
  retailerOffersWord: "retailer offers",
  legendSummary: "What the status labels mean",
  statusLegendAria: "Status legend",
  offerStatusAria: "Verification status",
  statusVerified: "Verified",
  statusUnverified: "Needs verification",
  statusStale: "Stale",
  statusVerifiedTip: "Cross-checked against the retailer’s live page during this collection run.",
  statusUnverifiedTip: "Collected from the retailer, not yet cross-checked. Treat as indicative.",
  statusStaleTip: "Collected more than 24 hours ago. Re-check before you buy.",
  savingsBaseline: "vs {x} listed price",
  bestEffectiveLabel: "best effective price",
  // REEA-1142 — market scope on the live offer set: a cross-market listing
  // names its market on the row ("Saudi price · ≈KD X") and the headline is
  // the selected market's cheapest offer, or the honest no-local-offer line.
  marketPrice: "{market} price",
  marketStock: "{market} stock",
  crossMarketHeadline: "No {market} offer · {marketOther} price from {price}",
  crossMarketLead: "{market} price {price}",
  crossMarketCaveat: "Delivery from {market} · customs may apply",
  checkedLead: "Checked",
  checkedJustNow: "Checked just now",
  offerGo: "Go",
  offerGoTo: "Go to {x}",
  offersTableTitle: "All offers · {n} retailers",
  /* REEA-1096 D6 — the capped shelf card points at the full live offer set on
     the product page; the disclosure carries the blocks outside the accepted
     card anatomy. */
  viewAllOffers: "View all {n} offers",
  cardMoreDetails: "Coupons, accessories & details",
  offersTableAria: "All offers by retailer",
  tableRetailer: "Retailer",
  tablePrice: "Price",
  tableStock: "Stock",
  tableStatus: "Status",
  tableChecked: "Checked",
  productCollected: "Collected live {age} · {n} retailers answered",
  productCollectedOne: "Collected live {age} · 1 retailer answered",
  productRetailersAnswered: "{n} retailers answered",
  couponApplied: "{x} coupon applied at checkout",
  homeRetailersTitle: "Retailers collecting now",
  homeLiveNote: "live per-query collection · last answer {age}",
  retailerLive: "live",
  retailerNoResponse: "no response",
  retailersMore: "+{n} more checked",
  homeDropsTitle: "Price drops right now",
  homeDropsNote: "Live · updated in the last minute",
  homeAllDrops: "All price drops",
  homeDropsEmptyTitle: "No price drops in the last hour",
  homeDropsEmptyNote:
    "We checked every retailer live just now. Nothing moved yet — the next collection runs when you open a product.",
  dropLower: "lower than its listed price",
  homeCategoriesTitle: "Browse by category",
  catPhones: "Phones",
  catLaptops: "Laptops",
  catHomeKitchen: "Home & kitchen",
  catAudio: "Audio",
  homeMethodTitle: "How the price you see is chosen",
  homeMethodBody:
    "We collect every retailer offer live, apply coupons that work at checkout, and rank by the price you actually pay. The best effective price always wins — no paid placement.",
  trustBest: "Best effective price ranks first, always",
  trustCoupons: "Coupons applied before ranking",
  trustProvenance: "Every price shows when it was collected and by whom",
  trustAffiliate: "Affiliate commission never changes the order",
  homeModuleLoading: "Checking retailers live…",
  homeModuleNoResponse: "No retailer answered just now.",
  homeChecked: "Checked",
  homePartialNote: "Some retailers are still answering — showing the live prices that arrived.",
  emptyRetailersAsked: "We asked every retailer just now.",
  errorRetailersTitle: "We couldn’t reach the retailers",
  errorRetailersBody:
    "No prices are being shown rather than showing a stale snapshot. Try again in a moment.",
  tryAgain: "Try again",
  footerHowCompare: "How we compare",
  marketLine: "Kuwait · prices in KWD",
  // REEA-448 G1: home-page chrome pair. The results templates localize through
  // buildResultsMeta; the home pair rides the same table so the ar session no
  // longer keeps the English <title>/description under lang="ar".
  homeTitle: "Reemco Price Compare",
  homeDescription:
    "Prices, coupons and stock, compared honestly across retailers.",
};

/** The AR dictionary is checked against the EN shape at compile time. */
const ar: typeof en = {
  toggleLabel: "English",
  toggleAria: "تبديل اللغة",
  searchPlaceholder: "ابحث عن منتج…",
  searchLabel: "ابحث عن منتج",
  searchButton: "بحث",
  refresh: "تحديث",
  footerAbout: "عن ريمكو",
  footerPrivacy: "الخصوصية",
  footerContact: "اتصل بنا",
  footerNav: "تذييل الصفحة",
  footerDisclosure:
    "تحصل ريمكو على عمولات إحالة من بعض روابط المتاجر، ولا يؤثر ذلك أبدًا في ترتيب النتائج — أفضل سعر فعلي يفوز دائمًا.",
  filterCountryAria: "تصفية العروض حسب البلد",
  filterAll: "الكل",
  countryKW: "الكويت",
  countrySA: "السعودية",
  countryEG: "مصر",
  showOutOfStock: "إظهار العناصر غير المتوفرة",
  inStock: "متوفر",
  outOfStock: "غير متوفر",
  bestPrice: "أفضل سعر",
  // REEA-835 — AR side of the lead-card checking state (EN: "Checking Kuwait
  // stores…"). Pure Arabic renders correctly under the RTL chrome; the
  // ellipsis trails the sentence in the locale's own script.
  kuwaitChecking: "نتحقق من متاجر الكويت…",
  lowestListed: "أقل سعر معروض",
  // REEA-963 — AR side of the sanity warning affordance (EN above). The badge
  // stays short; the per-reason sentences ride the title attribute.
  priceVerifyBadge: "السعر يحتاج إلى تحقق",
  // REEA-1178 AC3 — AR side of the possible-mismatch marker.
  mismatchBadge: "احتمال عدم تطابق",
  priceUnavailable: "السعر غير متوفر",
  verifyOutlier: "هذا الرقم بعيد عن السعر المعتاد لهذا البحث، لذا قد لا يكون قابلًا للمقارنة.",
  verifyCurrency: "لم نتمكن من التحقق من عملة هذا العرض، لذا قد يكون الرقم غير دقيق.",
  verifyNoPrice: "لم يوفر المتجر سعرًا صالحًا لهذا العرض.",
  saveLead: "وفّر",
  effectiveLead: "السعر بعد الخصم",
  effectiveTail: "بالكوبون",
  couponLead: "كوبون",
  // REEA-760 — AR side of the coupon honesty line, verbatim per spec §5.
  couponAutoNote: "تُطبَّق تلقائيًا عند الدفع",
  couponViaLead: "من",
  couponEffectiveLead: "بعد الخصم",
  compositionListed: "المعلن",
  compositionListedOnly: "المعلن {listed} · السعر النهائي يظهر عند الدفع",
  compositionMath: "المعلن {listed} − {discount} = تدفع {effective}",
  couponAppliedAtCheckout: "كوبون {x} خصم عند الدفع",
  couponUpTo: "حتى {x} خصمًا عند الدفع",
  // REEA-540 Bet A — AR counterpart of the results-card confidence pair.
  seenRecentlyLead: "شوهد مؤخرًا:",
  seenRecentlyWindow: "آخر 14 يومًا",
  // REEA-1167 — AR counterpart of the single-observation line.
  firstSeenLead: "شوهد لأول مرة:",
  viewAtLead: "افتح لدى",
  goToStore: "إلى المتجر",
  // REEA-930 — AR CTA pair (see the EN block for the composition rules).
  ctaCheckedLead: "تم التحقق",
  ageSec: "قبل {n}ث",
  ageMin: "قبل {n}د",
  ageHour: "قبل {n}س",
  ageDay: "قبل {n}ي",
  ctaBestLead: "أفضل سعر فعلي",
  ctaArrow: "←",
  pricesSectionAria: "الأسعار والتوافر حسب المتجر",
  pricesHeading: "أسعار المتاجر · دون التوصيل",
  colourOptionsAria: "خيارات اللون",
  variationsLabel: "الخيارات",
  // REEA-836 AC3 — disclosure label above the untouched retailer title string.
  originalTitleLabel: "العنوان الأصلي من المتجر",
  alternativesLabel: "بدائل",
  pairsWithLabel: "إكسسوارات مقترحة",
  devicesLabel: "أجهزة",
  accessoriesLabel: "ملحقات",
  retailersOne: "متجر",
  retailersMany: "متاجر",
  fromWord: "ابتداءً من",
  offerOne: "عرض",
  offerMany: "عروض",
  storesWord: "متاجر",
  timedOut: "انتهت المهلة",
  failedLabel: "فشل",
  retry: "إعادة المحاولة",
  retryCollection: "أعد المحاولة",
  collectNow: "ابدأ الجمع",
  collectAgain: "اجمع من جديد",
  startingLive: "جارٍ بدء الجمع المباشر…",
  idleLive: "الجمع المباشر غير نشط.",
  liveCollectionAria: "جمع الأسعار المباشر",
  collectingAria: "جمع العروض المباشرة",
  checkingStores: "جارٍ التحقق من المتاجر…",
  checkingStore: "جارٍ التحقق من {x}…",
  collectionComplete: "اكتمل الجمع",
  collectionFailed: "تعذّر جمع الأسعار",
  pricesInLead: "الأسعار بعملة",
  pricesInTail: "، والجمع خاص بهذا المنتج فقط.",
  viewAtRetailer: "افتح لدى المتجر ←",
  cachedLead: "نسخة مخزَّنة — حُدِّثت عند",
  showingCachedLead: "نعرض آخر النتائج المخزَّنة — جُمعت",
  staleNote: "(قديمة)",
  liveResultsLead: "نتائج مباشرة · جُمعت",
  collectedWord: "جُمعت",
  dateUnknown: "وقت غير معروف",
  justNow: "الآن",
  liveWord: "مباشر",
  cachedWord: "مخزَّن",
  updatedWord: "حُدِّث",
  freshUpdatedMinutes: "حُدِّث قبل {n} دقيقة",
  freshUpdatedMinute: "حُدِّث قبل دقيقة",
  freshJustNow: "حُدِّث الآن",
  freshUnknown: "تاريخ التحديث غير معروف",
  staleSuffix: " · قد يكون غير محدَّث",
  staleTitle: "آخر تحقق قبل أكثر من 7 أيام — قد يكون السعر غير محدَّث.",
  copyLabel: "نسخ",
  copyAriaLead: "انسخ رمز الخصم",
  // REEA-541 Bet B: same share-summary slots as EN, one layout for both locales.
  shareSummaryAria: "انسخ ملخص مقارنة الأسعار",
  shareBestNowLead: "أفضل سعر الآن",
  shareVerifiedWord: "تم التحقق",
  couponMoreSuffix: "أخرى",
  couponNoneLabel: "لا توجد قسيمة متاحة",
  errorTitle: "حدث خطأ ما",
  errorBody:
    "تعذّر إكمال تحميل هذه الصفحة. تحقق من اتصالك ثم أعد المحاولة — سيبقى بحثك كما هو.",
  errorBodyShort: "تعذّر تحميل النتائج. تحقق من اتصالك ثم أعد المحاولة.",
  notFoundTitle: "الصفحة غير موجودة",
  notFoundBody: "الصفحة التي تبحث عنها غير موجودة. جرّب إحدى عمليات البحث هذه:",
  emptyTitle: "لا توجد مطابقة",
  emptyBody: "تحقق من الإملاء أو جرّب مصطلح بحث أوسع.",
  // REEA-1114 AC1/AC2 — AR side of the filter-aware empty state. The title
  // follows the AC template "N نتيجة مخفية بسبب <filter>"; the unit is the
  // shipped plural pair so 2+ reads naturally (نتائج).
  emptyHiddenTitle: "{n} {unit} مخفية بسبب {filter}",
  matchOne: "نتيجة",
  matchMany: "نتائج",
  emptyHiddenBody:
    "وجدناها في النتائج الحية التي جلبناها الآن — فلتر {filter} يخفيها. يبقى بحثك كما هو.",
  emptyShowOutOfStock: "أظهر غير المتوفر",
  emptyShowAllCountries: "أظهر كل الدول",
  chipHiddenWord: "مخفية",
  chipHiddenAria: "{n} مخفية بسبب هذا الفلتر",
  emptyExample1: "آيفون",
  emptyExample2: "مكنسة دايسون",
  emptyExample3: "كيندل",
  relatedNotExactLabel: "عناصر ذات صلة — ليست مطابقة تامة",
  relatedChip: "ذات صلة",
  primaryResultsAria: "النتائج الأساسية",
  emptyUnavailable:
    "لم تستجب المتاجر هذه المرة — النتائج غير متوفرة مؤقتًا. حاول مرة أخرى بعد قليل.",
  emptyUnavailableTitle: "لم تستجب المتاجر هذه المرة",
  emptyHint: "لا توجد نتائج — جرّب عبارة أقصر.",
  // REEA-437 AC-2: empty state lists the search forms tried live.
  triedForms: "بحثنا في: {tries}.",
  resultsOne: "نتيجة",
  resultsMany: "نتائج",
  resultsForWord: "عن",
  allProducts: "كل المنتجات",
  heroLead: "اعثر على",
  heroAccent: "أفضل سعر",
  heroTail: ".",
  heroSub:
    "الأسعار والكوبونات وحالة التوافر تُجمع مباشرة من كل متجر لحظة فتح المنتج — مقارنة نزيهة، دون اعتماد على لقطات قديمة.",
  heroCaption:
    "يبدأ الجمع المباشر فور اختيار منتجك — تصل أولى العروض عادة خلال ثانية واحدة، ويعرض كل سعر وقت جمعه والمتجر الذي جمعه.",
  allOffersLead: "كل عروض هذا المنتج ←",
  aboutTitle: "عن ريمكو",
  aboutWhatLabel: "ما نفعله",
  aboutWhatBody:
    "ريمكو موقع لمقارنة الأسعار للتسوق في الكويت. ابحث عن منتج واحد وشاهد سعره وتوافره وكوبوناته وبدائله الأرخص عبر المتاجر في قائمة واحدة. الكويت أولا، ثم السعودية ومصر.",
  aboutWhoLabel: "من نقارن بينهم",
  aboutWhoBody: en.aboutWhoBody,
  aboutFreshLabel: "مدى حداثة الأسعار",
  aboutFreshBody:
    "تُجلب العروض مباشرة من كل متجر لحظة بحثك، لا من لقطة قديمة. وتعرض كل نتيجة وقت جمع سعرها.",
  privacyTitle: "الخصوصية",
  privacyLead: "بعبارة بسيطة: ما تسجله ريمكو، ولماذا.",
  privacyRecordLabel: "ما نسجله",
  privacyRecordBody:
    "أي منتج تم البحث عنه، وأي عروض فُتحت، ورابط أي متجر تم النقر عليه. السجلات عبار عن عدادات ونقرات مجهولة الهوية — بلا أسماء وبلا ملفات شخصية.",
  privacyWhyLabel: "لماذا",
  privacyWhyBody:
    "يخبرنا ذلك أي عمليات البحث تعطي نتائج جيدة وأين تحتاج نتائجنا إلى تحسين.",
  privacyLeaveLabel: "عند مغادرتك",
  privacyLeaveBody:
    "النقر على الرابط يفتح موقع المتجر نفسه، ومن تلك اللحظة تسري سياسة خصوصية المتجر نفسه.",
  contactTitle: "اتصل بنا",
  contactLead: "أسئلة أو تصحيحات أو متجر نقترح إضافته؟ راسلنا.",
  contactReply: "نحرص على الرد خلال يوم عمل واحد.",
  contactInclude: "أرفق اسم المنتج والمتجر الذي رأيت فيه السعر.",
  metaTitle: "أسعار {q} في {country} - ريمكو",
  metaDescription:
    "قارن الأسعار والكوبونات وحالة التوافر لـ{q} عبر متاجر {country}. تُجمع العروض لحظة بحثك — أفضل سعر فعلي يفوز.",
  // REEA-1168 — Arabic structured data: the name carries the localized
  // market phrase and the description is Arabic, matching the same Offer
  // freshness rules as the English page.
  jsonLdProductName: "{title} — أسعار في {country}",
  jsonLdProductDescription:
    "أسعار {title} في {country}: {n} عرضًا من المتاجر، تبدأ من {price} {cur}.",
  // REEA-1069 — Arabic Direction A "Shelf" chrome, designed in Arabic (not a
  // mirrored afterthought): price order, timestamps, status labels and CTAs
  // follow the signed REEA-1055 RTL checklist.
  brandHomeAria: "ريمكو — الرئيسية",
  menuLabel: "القائمة",
  menuClose: "أغلق القائمة",
  menuHowCompare: "كيف نقارن",
  toggleAriaTo: "تبديل اللغة إلى {lang}",
  // REEA-1159 — AR theme chrome, written in Arabic (not a mirrored fallback):
  // named by its state, with the same aria-pressed pair as EN.
  themeLabel: "الوضع الداكن",
  themeToggleTo: "التبديل إلى الوضع {theme}",
  themeLight: "الفاتح",
  themeDark: "الداكن",
  filterAria: "التصفية والسوق",
  filterSaudi: "السعودية",
  resultsHeading: "أسعار {q} في {country}",
  resultsHeadingAll: "أسعار كل المنتجات في {country}",
  resultsSubline: "{n} {unit} لـ«{q}» · {offers} عرضًا من المتاجر · جُمعت مباشرة {age}",
  productsWord: "منتجات",
  retailerOffersWord: "عروض المتاجر",
  legendSummary: "ماذا تعني حالات التحقق",
  statusLegendAria: "دليل حالات التحقق",
  offerStatusAria: "حالة التحقق",
  statusVerified: "موثّق",
  statusUnverified: "بحاجة للتحقق",
  statusStale: "قديم",
  statusVerifiedTip: "تم التحقق منه مقابل صفحة المتجر المباشرة أثناء هذا الجمع.",
  statusUnverifiedTip: "جُمع من المتجر ولم يُتحقق منه بعد. تعامل معه كإشارة.",
  statusStaleTip: "جُمع قبل أكثر من 24 ساعة. أعد التحقق قبل الشراء.",
  savingsBaseline: "مقارنةً بسعر {x} المعلن",
  bestEffectiveLabel: "أفضل سعر فعلي",
  // REEA-1142 — نفس نطاق السوق في النسخة العربية.
  marketPrice: "سعر {market}",
  marketStock: "مخزون {market}",
  crossMarketHeadline: "لا يوجد عرض في {market} · سعر {marketOther} من {price}",
  crossMarketLead: "سعر {market} {price}",
  crossMarketCaveat: "التوصيل من {market} · قد تُطبَّق رسوم جمركية",
  checkedLead: "حُدِّث",
  checkedJustNow: "حُدِّث الآن",
  offerGo: "اذهب",
  offerGoTo: "اذهب إلى {x}",
  offersTableTitle: "كل العروض · {n} متاجر",
  viewAllOffers: "عرض كل {n} عروض",
  cardMoreDetails: "الكوبونات والإكسسوارات والتفاصيل",
  offersTableAria: "كل العروض حسب المتجر",
  tableRetailer: "المتجر",
  tablePrice: "السعر",
  tableStock: "التوافر",
  tableStatus: "الحالة",
  tableChecked: "وقت الجمع",
  productCollected: "جُمع مباشرةً {age} · استجاب {n} من المتاجر",
  productCollectedOne: "جُمع مباشرةً {age} · استجاب متجر واحد",
  productRetailersAnswered: "استجاب {n} متاجر",
  couponApplied: "كوبون {x} يُطبَّق عند الدفع",
  homeRetailersTitle: "متاجر تجمع الآن",
  homeLiveNote: "جمع مباشر لكل بحث · آخر إجابة {age}",
  retailerLive: "مباشر",
  retailerNoResponse: "لا استجابة",
  retailersMore: "+{n} أخرى تم فحصها",
  homeDropsTitle: "انخفاضات الأسعار الآن",
  homeDropsNote: "مباشر · حُدِّث خلال الدقيقة الأخيرة",
  homeAllDrops: "كل انخفاضات الأسعار",
  homeDropsEmptyTitle: "لا انخفاضات خلال الساعة الأخيرة",
  homeDropsEmptyNote:
    "تحققنا من كل متجر مباشرةً الآن. لم يتغير شيء بعد — يبدأ الجمع التالي عند فتح منتج.",
  dropLower: "أقل من سعره المعلن",
  homeCategoriesTitle: "تصفح حسب الفئة",
  catPhones: "هواتف",
  catLaptops: "حواسيب محمولة",
  catHomeKitchen: "المنزل والمطبخ",
  catAudio: "صوتيات",
  homeMethodTitle: "كيف يُختار السعر الذي تراه",
  homeMethodBody:
    "نجمع كل عرض من المتاجر مباشرةً، ونطبق الكوبونات الصالحة عند الدفع، ونرتب حسب السعر الذي تدفعه فعليًا. أفضل سعر فعلي يفوز دائمًا — بلا ترتيب مدفوع.",
  trustBest: "أفضل سعر فعلي يتصدر دائمًا",
  trustCoupons: "تُطبق الكوبونات قبل الترتيب",
  trustProvenance: "كل سعر يوضح وقت جمعه ومن جمعه",
  trustAffiliate: "عمولة الإحالة لا تغير الترتيب",
  homeModuleLoading: "جارٍ التحقق من المتاجر مباشرة…",
  homeModuleNoResponse: "لم يستجب أي متجر الآن.",
  homeChecked: "تم التحقق",
  homePartialNote: "بعض المتاجر لا تزال تستجيب — تُعرض الأسعار المباشرة التي وصلت.",
  emptyRetailersAsked: "سألنا كل متجر الآن.",
  errorRetailersTitle: "تعذّر الوصول إلى المتاجر",
  errorRetailersBody: "لا نعرض أسعارًا بدلًا من عرض لقطة قديمة. حاول مرة أخرى بعد قليل.",
  tryAgain: "أعد المحاولة",
  footerHowCompare: "كيف نقارن",
  marketLine: "الكويت · الأسعار بالدينار الكويتي",
  // REEA-448 G1: Arabic home chrome pair, verbatim from the REEA-440 spec.
  homeTitle: "ريمكو — قارن الأسعار في الكويت",
  homeDescription:
    "قارن الأسعار والكوبونات وحالة التوافر عبر متاجر الكويت. تُجمع العروض لحظة بحثك — أفضل سعر فعلي يفوز.",
};

export type Strings = typeof en;

export function getStrings(locale: Locale): Strings {
  return locale === "ar" ? ar : en;
}

export function localeDir(locale: Locale): "rtl" | "ltr" {
  return locale === "ar" ? "rtl" : "ltr";
}

/** Replace {q}/{n}/{x}/{cur} placeholders in a table value. */
export function fill(tpl: string, values: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
}

/**
 * REEA-930 scope 1 — localized short age for offer-CTA freshness lines, the
 * same s/m/h/d bucket ladder as relativeAge but in the locale's copy. Pure
 * and deterministic in (locale, seconds) so SSR and hydration agree when both
 * derive from the same baked clock; negative/NaN inputs never reach here
 * (ageSeconds filters them). Latin digits in both locales, per REEA-488.
 */
export function localizedAge(locale: Locale, seconds: number): string {
  const t = getStrings(locale);
  const s = Math.max(0, Math.floor(seconds));
  const n =
    s < 60 ? s : s < 3600 ? Math.floor(s / 60) : s < 86400 ? Math.floor(s / 3600) : Math.floor(s / 86400);
  return fill(s < 60 ? t.ageSec : s < 3600 ? t.ageMin : s < 86400 ? t.ageHour : t.ageDay, { n });
}


/**
 * REEA-1069 + REEA-1096 D8 — the Arabic duration phrase the signed RTL
 * checklist requires (`قبل دقيقتين` / `قبل 4 دقائق` / `قبل 26 دقيقة`), with
 * the correct dual/plural forms and the `قبل` preposition that was missing.
 */
function arabicAgePhrase(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const unit =
    s < 60 ? ["لحظة", "ثانية", "ثانيتين", "ثوانٍ", "ثانية"]
    : s < 3600 ? ["دقيقة", "دقيقة", "دقيقتين", "دقائق", "دقيقة"]
    : s < 86400 ? ["ساعة", "ساعة", "ساعتين", "ساعات", "ساعة"]
    : ["يوم", "يوم", "يومين", "أيام", "يوم"];
  const n = s < 60 ? s : s < 3600 ? Math.floor(s / 60) : s < 86400 ? Math.floor(s / 3600) : Math.floor(s / 86400);
  if (n === 1) return `قبل ${unit[1]}`;
  if (n === 2) return `قبل ${unit[2]}`;
  if (n >= 3 && n <= 10) return `قبل ${n} ${unit[3]}`;
  return `قبل ${n} ${unit[4]}`;
}

/**
 * REEA-1069 — humanised, locale-correct "checked" age for offer rows
 * (RTL checklist §A.3). English keeps the compact shelf form; Arabic gets the
 * correct dual/plural forms the signed checklist requires:
 * حُدِّث الآن / حُدِّث قبل دقيقتين / حُدِّث قبل 4 دقائق / حُدِّث قبل 26 دقيقة —
 * never "0s ago", never an untranslated fragment.
 */
export function checkedAgeLabel(locale: Locale, seconds: number): string {
  const t = getStrings(locale);
  const s = Math.max(0, Math.floor(seconds));
  if (locale === "en") {
    if (s < 60) return t.checkedJustNow;
    return `${t.checkedLead} ${localizedAge("en", s).replace(/ ago$/, "")} ago`;
  }
  if (s <= 5) return t.checkedJustNow;
  return `${t.checkedLead} ${arabicAgePhrase(s)}`;
}

/**
 * REEA-1096 D8 — the bare age phrase for the results meta line. The meta
 * line already says "collected live" / `جُمعت مباشرة`; concatenating the full
 * checked sentence produced `جُمعت مباشرة حُدِّث 4 دقائق`. This returns just
 * the duration (`4m ago` / `قبل 4 دقائق`), so the sentence reads
 * `جُمعت مباشرة قبل 4 دقائق` and never repeats the verb.
 */
export function collectedAgeLabel(locale: Locale, seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (locale === "en") return localizedAge("en", s);
  return arabicAgePhrase(s);
}

/* ---- Resolution chain: cookie → Accept-Language hint → "en". ------------ */

/** Allowlisted normalize of the cookie value; anything else reads as unset. */
export function normalizeLocaleCookie(raw: unknown): Locale | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (v === "ar") return "ar";
  if (v === "en") return "en";
  return null;
}

/**
 * Coarse Accept-Language hint (mirrors countryFromAcceptLanguage in
 * country.ts): walk the locales in weight order (q descending, stable on
 * equal q) and take the first primary language subtag we serve ("ar"/"en").
 * Region subtags are ignored — the language alone decides the chrome. `null`
 * when the header stated no language we serve (or nothing at all), so the
 * REEA-448 chain can fall through to the query-text step instead of treating
 * "no hint" as a positive "en" answer.
 */
export function hintLocaleFromAcceptLanguage(
  header: string | null | undefined,
): Locale | null {
  if (!header) return null;
  const entries: { locale: Locale | null; q: number; order: number }[] = [];
  header.split(",").forEach((part, order) => {
    const segments = part.trim().split(";");
    const tag = segments[0]?.trim().toLowerCase();
    if (!tag) return;
    let q = 1;
    for (const p of segments.slice(1)) {
      const m = /^q=(\d(?:\.\d+)?)$/i.exec(p.trim());
      if (m) q = Number(m[1]);
    }
    const lang = tag.split("-")[0];
    const locale: Locale | null = lang === "ar" ? "ar" : lang === "en" ? "en" : null;
    entries.push({ locale, q: Number.isFinite(q) ? q : 1, order });
  });
  entries.sort((a, b) => b.q - a.q || a.order - b.order);
  for (const e of entries) if (e.locale) return e.locale;
  return null;
}

/** Back-compatible wrapper over the nullable hint: "en" when no hint. */
export function localeFromAcceptLanguage(
  header: string | null | undefined,
): Locale {
  return hintLocaleFromAcceptLanguage(header) ?? "en";
}

/**
 * REEA-448 G2 step 3: the query text itself is the shopper's own language
 * signal — Arabic-script codepoints (U+0600–U+06FF) decide "ar" when neither
 * the cookie nor Accept-Language stated a preference. This is what stops the
 * mixed "آيفون prices in Kuwait - Reemco" title when no header is sent.
 */
export function localeFromQueryText(
  queryText: string | null | undefined,
): Locale | null {
  if (!queryText) return null;
  return /[\u0600-\u06FF]/.test(queryText) ? "ar" : null;
}

/** The one chain every surface shares (REEA-448 order): stated cookie first,
 *  then a header that starts with ar, then an Arabic-script query text, then
 *  an explicit en header or the "en" default. Per REEA-451 F2 an explicit en
 *  header does NOT block the query-script step: an Arabic query resolves ar
 *  even when Accept-Language says en (or is absent). Same shape as
 *  resolveCountrySelection. */
export function resolveUiLocale(
  cookieRaw: unknown,
  acceptLanguage: string | null | undefined,
  queryText?: string,
): Locale {
  const stated = normalizeLocaleCookie(cookieRaw);
  if (stated) return stated;
  const hint = hintLocaleFromAcceptLanguage(acceptLanguage);
  if (hint === "ar") return hint;
  const fromQuery = localeFromQueryText(queryText);
  if (fromQuery) return fromQuery;
  return hint ?? "en";
}

/** The cookie read behind everything (mirrors readMarketCookie). */
export function readLocaleCookie(): Locale | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=([^;]*)`));
  return normalizeLocaleCookie(match?.[1]);
}

/**
 * Client-side chain for hosts without server resolution (static export) and
 * for components rendered without a locale prop (tests). During SSR the same
 * function runs with no document and lands on "en" — that is why server
 * surfaces always pass the resolved locale DOWN as a prop.
 */
export function clientLocale(): Locale {
  const fromCookie = readLocaleCookie();
  if (fromCookie) return fromCookie;
  const nav = typeof navigator !== "undefined" ? navigator.language : undefined;
  return localeFromAcceptLanguage(nav ?? null);
}

/** Toggle writes: the ONLY persistent storage the locale feature keeps. */
export function rememberLocale(locale: Locale): void {
  if (typeof document !== "undefined") {
    document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax`;
  }
}

/** Test support: deterministic starting point across cases. */
export function resetLocalePrefs(): void {
  if (typeof document !== "undefined") {
    document.cookie = `${LOCALE_COOKIE}=; path=/; max-age=0`;
  }
}

/**
 * Server-side read behind the layout and pages lives in
 * src/lib/i18n-server.ts: request-time `next/headers` reads belong to the
 * Server Components' graph, and every client bundle stays inside this pure
 * module. The chain itself remains resolveUiLocale above, so server and
 * client resolutions stay one shared function.
 */
