/**
 * REEA-1200 — Bet 7A-1 relevance/scope panel probe.
 *
 * QA-runnable with no arguments and no browser:
 *
 *   BASE_URL=https://ns539626.ip-144-217-72.net node scripts/reea1200-relevance-panel.mjs
 *
 * It runs the AC 7a-9 panel — panadol, cucumber, samsung galaxy s25 ultra,
 * laptop, headphones, iphone 17 pro — plus the `zzzzqqq` control, in EN and
 * AR, and prints per query/locale:
 *   - the served `/__commit.txt` + `/api/health` stamp read BEFORE the run,
 *   - the payload cards and their `matchReason`/`productScope` fields
 *     (AC 7a-1: 0 rendered cards may lack both),
 *   - the primary-scope card count (the shelf the page paints — the same
 *     predicate `lib/scope-gate.ts isPrimaryShelfScope` and the renderer
 *     chain use: productScope primary/variant AND matchReason ≠ related),
 *   - the off-scope count ON the primary shelf, measured by an independent
 *     title-level predicate for each AC (so a misclassification is caught by
 *     the outcome, not just by the field the classifier wrote),
 *   - accessory/consumable band counts,
 *   - `zzzzqqq`: the empty state (0 cards, 0 primary-scope cards).
 *
 * The probe reads the served document's RSC flight payload (the same live
 * collection the page rendered) and falls back to the live follow-up feed
 * only when the document carried no products at all. It never uses a
 * browser. Its UA identifies as a bot so the serve is excluded from the
 * clean CTR denominator (Bet 7C).
 *
 * Exit code is 0 even when a count looks wrong; QA reads the table and the
 * PASS/FAIL lines. Nothing here mutates anything.
 */

const BASE = (process.env.BASE_URL || "https://ns539626.ip-144-217-72.net").replace(/\/$/, "");
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 120000);
const LOCALES = ["en", "ar"];
const QUERIES = [
  "panadol",
  "cucumber",
  "samsung galaxy s25 ultra",
  "laptop",
  "headphones",
  "iphone 17 pro",
  "zzzzqqq",
];
// Bot-identified UA: the probe's own serves must not pollute the clean CTR
// denominator (Bet 7C / lib/bot-ua.ts).
const UA = "reea1200-relevance-panel-bot/1.0 (+QA panel)";

// ---------------------------------------------------------------------------
// RSC flight decoding (same technique as scripts/reea1143-panel.mjs): the
// served document carries the streamed React tree; concatenating the decoded
// self.__next_f.push chunks reconstructs it.
// ---------------------------------------------------------------------------
function decodeFlight(html) {
  const chunks = [];
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      chunks.push(JSON.parse(m[1]));
    } catch {
      // a chunk that is not a standalone string literal is not ours
    }
  }
  return chunks.join("");
}

function extractArray(text, key) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(`"${key}":[`, from);
    if (at < 0) break;
    const i = text.indexOf("[", at);
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let p = i; p < text.length; p += 1) {
      const ch = text[p];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "[") depth += 1;
      else if (ch === "]") {
        depth -= 1;
        if (depth === 0) {
          end = p;
          break;
        }
      }
    }
    if (end < 0) break;
    try {
      out.push(JSON.parse(text.slice(i, end + 1)));
    } catch {
      // skip an unparsable fragment
    }
    from = end + 1;
  }
  if (!out.length) return null;
  return out.reduce((best, cur) => (cur.length > best.length ? cur : best), out[0]);
}

// ---------------------------------------------------------------------------
// Served stamp, read BEFORE each run (AC 7a-9).
// ---------------------------------------------------------------------------
async function readStamp() {
  const stamp = { commit: null, health: null };
  try {
    const res = await fetch(`${BASE}/__commit.txt`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    stamp.commit = (await res.text()).trim();
  } catch (err) {
    stamp.commit = `unreadable: ${err?.message ?? err}`;
  }
  try {
    const res = await fetch(`${BASE}/api/health`, {
      headers: { "User-Agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    stamp.health = await res.text();
  } catch (err) {
    stamp.health = `unreadable: ${err?.message ?? err}`;
  }
  return stamp;
}

// ---------------------------------------------------------------------------
// AC 7a-2…7a-5 — the independent, title-level in-scope predicates. These are
// written from the AC text, not from the payload fields, so the probe verifies
// the OUTCOME even if the classifier mislabels a card.
// ---------------------------------------------------------------------------
const ACCESSORY_TITLE_RE =
  /case|cover|protector|lens|film|skin|adapter|charger|cable|sleeve|bundle|كفر|جراب|واقي|غطاء|شاحن|كيبل|عدسة|فيلم/i;

const AC_PREDICATES = {
  panadol: {
    label: "AC 7a-2 — paracetamol family only",
    inScope: (title) => /\bpanadol\b|\bpanadrex\b|\bparacetamol\b/i.test(title),
  },
  cucumber: {
    label: "AC 7a-3 — fresh cucumber only (no soap/deodorant/laban/pickle/slime)",
    inScope: (title) =>
      /cucumber|خيار/i.test(title) &&
      !/soap|deodorant|antiperspirant|laban|drink|pickle|slime|toy|صابون|مزيل|لبن|مشروب|مخلل|سلايم|لعبة/i.test(
        title,
      ),
  },
  "samsung galaxy s25 ultra": {
    label: "AC 7a-4 — S25-family phones only (no cases/protectors/lenses)",
    inScope: (title) => /s25/i.test(title) && !ACCESSORY_TITLE_RE.test(title),
  },
  laptop: {
    label: "AC 7a-5 — laptop computers only (no bags/trolleys/backpacks)",
    inScope: (title) =>
      /laptop|notebook|macbook|لابتوب|حاسوب/i.test(title) &&
      !/bag|trolley|backpack|suitcase|luggage|sleeve|حقيبة|شنطة|ترولي|ظهر/i.test(title),
  },
  headphones: {
    label: "AC 7a-8 — headphone rows stay in scope",
    inScope: (title) => /headphone|earphone|earbud|headset|سماع/i.test(title),
  },
  "iphone 17 pro": {
    label: "AC 7a-8 — iPhone 17 Pro phone cards stay in scope",
    inScope: (title) =>
      (/iphone|ايفون/i.test(title) && /17/.test(title) && /pro|برو/i.test(title)) ||
      /iphone17/i.test(title),
  },
  zzzzqqq: {
    label: "AC 7a-7 — the control returns the empty state",
    inScope: () => true, // nothing should be in scope; the count is what matters
  },
};

function scopeOf(card) {
  return {
    matchReason: typeof card.matchReason === "string" ? card.matchReason : null,
    productScope: typeof card.productScope === "string" ? card.productScope : null,
  };
}

/**
 * The primary shelf the page paints: the payload-scope partition the renderer
 * runs (scope primary/variant). The gate never stamps a primary/variant card
 * with `related`; `relatedInPrimary` is checked separately so AC 7a-6 is
 * measured, not assumed.
 */
function primaryScope(cards) {
  return cards.filter((c) => {
    const { productScope } = scopeOf(c);
    return productScope === "primary" || productScope === "variant";
  });
}

/** AC 7a-6 — a card the gate matched only as `related` must not fill a slot. */
function relatedInPrimary(cards) {
  return cards.filter((c) => c.matchReason === "related");
}

/** The default stock view hides cards whose offers are all out of stock. */
function visibleUnderDefaultStockView(cards) {
  return cards.filter((c) => (c.offers || []).some((o) => o.inStock !== false));
}

// ---------------------------------------------------------------------------
// One probe run.
// ---------------------------------------------------------------------------
async function fetchOnce(query, locale) {
  const url = `${BASE}/results?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { Cookie: `rc_locale=${locale}`, "User-Agent": UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const html = await res.text();
  const flight = decodeFlight(html);
  const products = extractArray(flight, "products") || [];
  if (products.length > 0) return { http: res.status, products, source: "served document" };
  // First paint carried nothing: read the same run's converged live answer
  // through the follow-up feed (still live-at-query-time, never bundled).
  try {
    const follow = await fetch(`${BASE}/api/results-followup?q=${encodeURIComponent(query)}`, {
      headers: { Cookie: `rc_locale=${locale}`, "User-Agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const snap = await follow.json();
    return { http: res.status, products: snap?.products ?? [], source: "follow-up feed" };
  } catch {
    return { http: res.status, products, source: "served document (empty)" };
  }
}

/**
 * A live lane can miss the completion budget for one run (the panel is
 * inventory-driven). A non-control query that answered with zero cards is
 * retried once — a zero shelf is a real answer only for `zzzzqqq`, and a
 * flaky zero must not read as "0 off-scope".
 */
async function fetchProducts(query, locale) {
  const first = await fetchOnce(query, locale);
  if (first.products.length > 0 || query === "zzzzqqq") return first;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const second = await fetchOnce(query, locale);
  return second.products.length > 0
    ? second
    : { ...second, source: `${second.source} (retried, empty)` };
}

async function probe(query, locale) {
  const stamp = await readStamp();
  const started = Date.now();
  const { http, products, source } = await fetchProducts(query, locale);
  const cards = products.map((p) => ({
    title: p.title,
    brand: p.brand,
    ...scopeOf(p),
    offers: p.offers || [],
    merchants: [...new Set((p.offers || []).map((o) => o.merchant))],
  }));
  const missing = cards.filter((c) => c.matchReason === null || c.productScope === null);
  const primary = primaryScope(cards);
  const relatedPrimary = relatedInPrimary(primary);
  const visiblePrimary = visibleUnderDefaultStockView(primary);
  const predicate = AC_PREDICATES[query];
  // The page paints the DEFAULT stock view (all-OOS cards are hidden by the
  // In stock selection), so the AC "primary shelf contains only …" is measured
  // on the rendered primary set, not on rows the viewer never sees. The raw
  // payload count is printed beside it so a difference is attributable.
  const renderedPrimary = visibleUnderDefaultStockView(primary);
  const offScopeOnPrimary = renderedPrimary.filter((c) => !predicate.inScope(c.title));
  const accessory = cards.filter((c) => c.productScope === "accessory");
  const consumable = cards.filter((c) => c.productScope === "consumable");
  return {
    query,
    locale,
    stamp,
    http,
    source,
    ms: Date.now() - started,
    cards,
    missing,
    primary,
    relatedPrimary,
    renderedPrimary,
    offScopeOnPrimary,
    accessory,
    consumable,
    predicate,
  };
}

function printRun(r) {
  const line = (s) => console.log(s);
  line("");
  line(`=== ${r.query} | locale=${r.locale} | http=${r.http} | ${r.ms} ms | source=${r.source}`);
  line(`stamp BEFORE run: /__commit.txt=${r.stamp.commit} | /api/health=${r.stamp.health}`);
  line(
    `payload cards=${r.cards.length} | payload primary-scope=${r.primary.length} | rendered primary (default stock view; the count line reads this)=${r.renderedPrimary.length} | off-scope on rendered primary=${r.offScopeOnPrimary.length} | accessory band=${r.accessory.length} | consumable band=${r.consumable.length} | rendered cards missing fields=${r.renderedPrimary.filter((c) => c.matchReason === null || c.productScope === null).length} | related cards in primary=${r.relatedPrimary.length}`,
  );
  if (r.cards.length === 0) {
    line("EMPTY STATE — 0 cards (zzzzqqq control must read exactly this)");
    return;
  }
  line("rendered primary shelf (title | productScope | matchReason):");
  for (const c of r.renderedPrimary) line(`  - ${c.title} | ${c.productScope} | ${c.matchReason}`);
  const hidden = r.primary.length - r.renderedPrimary.length;
  if (hidden > 0) {
    line(`(${hidden} payload primary-scope card(s) hidden by the default In stock view — not padding)`);
  }
  if (r.offScopeOnPrimary.length > 0) {
    line(`OFF-SCOPE ON PRIMARY SHELF (${r.predicate.label}):`);
    for (const c of r.offScopeOnPrimary) line(`  ! ${c.title} | ${c.productScope} | ${c.matchReason}`);
  }
  if (r.relatedPrimary.length > 0) {
    line("RELATED-MATCHED CARDS IN PRIMARY (AC 7a-6 violation):");
    for (const c of r.relatedPrimary) line(`  ! ${c.title} | ${c.productScope} | ${c.matchReason}`);
  }
  const renderedMissing = r.renderedPrimary.filter((c) => c.matchReason === null || c.productScope === null);
  if (renderedMissing.length > 0) {
    line("RENDERED CARDS MISSING matchReason/productScope (AC 7a-1 violation):");
    for (const c of renderedMissing) line(`  ? ${c.title}`);
  }
  if (r.accessory.length > 0) {
    line(`accessory band rows (${r.accessory.length}):`);
    for (const c of r.accessory.slice(0, 8)) line(`  ~ ${c.title} | ${c.productScope} | ${c.matchReason}`);
  }
  if (r.consumable.length > 0) {
    line(`consumable rows (${r.consumable.length}):`);
    for (const c of r.consumable.slice(0, 8)) line(`  ~ ${c.title} | ${c.productScope} | ${c.matchReason}`);
  }
}

function verdict(r) {
  if (r.query === "zzzzqqq") {
    return r.cards.length === 0 && r.primary.length === 0 ? "PASS" : "FAIL (control is not empty)";
  }
  const problems = [];
  const renderedMissing = r.renderedPrimary.filter((c) => c.matchReason === null || c.productScope === null);
  if (renderedMissing.length > 0) problems.push(`${renderedMissing.length} rendered card(s) missing fields`);
  if (r.offScopeOnPrimary.length > 0) problems.push(`${r.offScopeOnPrimary.length} off-scope on rendered primary`);
  if (r.relatedPrimary.length > 0) problems.push(`${r.relatedPrimary.length} related card(s) in primary`);
  if (r.query === "samsung galaxy s25 ultra" && r.renderedPrimary.length < 1) problems.push("no S25-family phone on primary");
  if (r.query === "laptop" && r.renderedPrimary.length < 4) problems.push("fewer than 4 laptops on primary");
  if (r.query === "iphone 17 pro" && r.renderedPrimary.length < 6) problems.push("fewer than 6 iPhone cards on primary");
  return problems.length === 0 ? "PASS" : `FAIL (${problems.join("; ")})`;
}

async function main() {
  console.log("REEA-1200 Bet 7A-1 relevance/scope panel");
  console.log(`BASE_URL=${BASE} | locales=${LOCALES.join(",")} | queries=${QUERIES.length}`);
  const stamp = await readStamp();
  console.log(`served head at probe start: /__commit.txt=${stamp.commit} | /api/health=${stamp.health}`);
  const results = [];
  for (const locale of LOCALES) {
    for (const query of QUERIES) {
      const r = await probe(query, locale);
      printRun(r);
      r.verdict = verdict(r);
      results.push(r);
    }
  }
  console.log("");
  console.log("SUMMARY (query | locale | payload cards | payload primary-scope | rendered primary (default view) | off-scope on rendered primary | missing fields on rendered | verdict)");
  for (const r of results) {
    const renderedMissing = r.renderedPrimary.filter((c) => c.matchReason === null || c.productScope === null).length;
    console.log(
      `${r.query} | ${r.locale} | ${r.cards.length} | ${r.primary.length} | ${r.renderedPrimary.length} | ${r.offScopeOnPrimary.length} | ${renderedMissing} | ${r.verdict}`,
    );
  }
  console.log("");
  console.log("Note: AC 7a-6 compares the rendered primary-card count with the in-scope count on the SAME view — the count line reads the rendered set. A payload primary-scope card whose every offer is out of stock is hidden by the default In stock selection (pre-existing filter), so the payload count can exceed the rendered count by exactly those hidden cards; the probe prints both.");
  const failed = results.filter((r) => !r.verdict.startsWith("PASS"));
  console.log("");
  console.log(failed.length === 0 ? "PANEL: PASS (all AC rows)" : `PANEL: ${failed.length} row(s) need attention`);
}

main().catch((err) => {
  console.error("probe failed:", err?.message ?? err);
  process.exitCode = 1;
});
