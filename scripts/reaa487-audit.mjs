/** REEA-487 — brand-attribution audit probe.
 *
 *  Samples live offer feeds for Quadra Stores (the misbranded `Manufacturer`
 *  option) and every other JSON-brand adapter (Xcite, Jarir, Eureka, Sultan
 *  Center, Blink; the scanner-backed hops Lulu / PC Kuwait carry no brand
 *  field and are checked from their contract), extracts the {title, brand}
 *  pairs exactly where the shipped adapters read them, and reports how the
 *  REEA-487 conflict rule in resolveBrand moves the brand line. Prints
 *  before/after samples plus per-adapter flip counts and the Quadra >=50-item
 *  agreement table the acceptance criteria ask for.
 *
 *  Usage: node --experimental-strip-types scripts/reaa487-audit.mjs
 */
import { resolveBrand } from "../src/lib/relevance.ts";

const HEADERS = { accept: "application/json", "accept-language": "en" };
const QUADRA_QUERIES = ["razer huntsman", "steelseries", "logitech", "corsair", "apple"];
const OTHER_QUERIES = ["razer huntsman", "corsair", "logitech"];

async function getJson(url, init) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(20000), ...init });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/* ---- per-adapter pair extraction, mirroring the shipped contracts ---- */

function pickBrand(hit) {
  for (const key of ["brand", "Brand", "brand_name", "brandName", "vendor", "manufacturer"]) {
    const v = hit[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return undefined;
}

const suggestPairs = (payload) => {
  const products = payload?.resources?.results?.products ?? payload?.products ?? [];
  const out = [];
  for (const p of products) {
    if (typeof p?.title !== "string") continue;
    const option1 = p.variants?.[0]?.option1;
    const brand = option1?.trim() || pickBrand(p);
    if (brand) out.push({ title: p.title, brand });
  }
  return out;
};

async function quadraPairs() {
  const pairs = [];
  for (const q of QUADRA_QUERIES) {
    const payload = await getJson(
      `https://quadrastores.com/search/suggest.json?q=${encodeURIComponent(q)}&resources[type]=product&resources[limit]=10`,
    );
    pairs.push(...suggestPairs(payload));
  }
  return dedupe(pairs);
}

async function blinkPairs() {
  const pairs = [];
  for (const q of OTHER_QUERIES.slice(0, 2)) {
    const payload = await getJson(
      `https://blink.com.kw/search/suggest.json?q=${encodeURIComponent(q)}&resources[type]=product&resources[limit]=10`,
    );
    pairs.push(...suggestPairs(payload));
  }
  return dedupe(pairs);
}

async function xcitePairs() {
  const payload = await getJson("https://www.xcite.com/api/algolia/proxy", {
    method: "POST",
    headers: { ...HEADERS, "content-type": "application/json" },
    body: JSON.stringify({ requests: [{ indexName: "xcite_prod_kw_en_main", params: { query: "razer huntsman", hitsPerPage: 10 } }] }),
  });
  const hits = payload?.results?.[0]?.hits ?? [];
  const out = [];
  for (const hit of hits) {
    const brand = pickBrand(hit);
    if (typeof hit?.name === "string" && brand) out.push({ title: hit.name, brand });
  }
  return dedupe(out);
}

async function jarirPairs() {
  const page = await fetch("https://www.jarir.com/", { headers: { accept: "text/html" }, signal: AbortSignal.timeout(20000) });
  const html = await page.text();
  const anchor = html.indexOf("searchProviderKeys");
  const haystack = anchor >= 0 ? html.slice(anchor) : html;
  const keys = [...haystack.matchAll(/"(key_[A-Za-z0-9_-]{6,})"/g)].map((m) => m[1]);
  const indexKey = keys[keys.length - 1];
  if (!indexKey) return [];
  const payload = await getJson(`https://ac.cnstrc.com/search/${encodeURIComponent("steelseries")}?key=${indexKey}&num_results_per_page=10`);
  const out = [];
  for (const row of payload?.response?.results ?? []) {
    const meta = row?.data?.metadata ?? {};
    const brand = pickBrand(meta);
    if (typeof meta?.name === "string" && brand) out.push({ title: meta.name, brand });
  }
  return dedupe(out);
}

async function eurekaPairs() {
  const page = await fetch("https://www.eureka.com.kw/", { headers: { accept: "text/html" }, signal: AbortSignal.timeout(20000) });
  const html = await page.text();
  const appId = html.match(/id="cky"[^>]*value="([^"]+)"/)?.[1];
  const searchKey = html.match(/id="srcapk"[^>]*value="([^"]+)"/)?.[1];
  if (!appId || !searchKey) return [];
  const payload = await getJson(
    `https://${appId}-dsn.algolia.net/1/indexes/instant_records/query?x-algolia-application-id=${appId}&x-algolia-api-key=${searchKey}`,
    { method: "POST", headers: { ...HEADERS, "content-type": "application/json" }, body: JSON.stringify({ params: "query=logitech&hitsPerPage=10" }) },
  );
  const out = [];
  for (const hit of payload?.hits ?? []) {
    const brand = pickBrand(hit);
    if (typeof hit?.itmn === "string" && brand) out.push({ title: hit.itmn, brand });
  }
  return dedupe(out);
}

async function sultanPairs() {
  const payload = await getJson("https://www.sultan-center.com/mobile/api/search", {
    method: "POST",
    headers: { ...HEADERS, "content-type": "application/json" },
    body: JSON.stringify({
      customerId: "", delivery_type: "home_delivery", currentpage: 1, filters: [], sortType: "position",
      currency: "KD", version: "eyJ2ZXJzaW9uX25hbWUiOiI3LjciLCJwbGF0Zm9ybSI6IklvcyJ9", substoreId: "45",
      store: 1, sortOrder: "asc", search_data: "rice", pagesize: 10, area: "", uid: null, deviceId: "reemco-web",
      is_web: 1, store_type: "ecom", latitude: "", longitude: "", isDesktop: "Desktop",
    }),
  });
  const out = [];
  for (const item of payload?.products?.product_list ?? []) {
    const brand = pickBrand(item);
    if (typeof item?.name === "string" && brand) out.push({ title: item.name, brand });
  }
  return dedupe(out);
}

/* ---- report ---- */

function dedupe(pairs) {
  const seen = new Set();
  const out = [];
  for (const p of pairs) {
    const key = `${p.title}|${p.brand}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

/** Old Rule-1 branch for reference: populated field wins verbatim (curated
 *  casing only) — so a flip is counted whenever the new rule returns a brand
 *  whose lowercase form differs from the field's lowercase form. */

function flipCount(pairs) {
  let flips = 0;
  for (const { title, brand } of pairs) {
    const after = resolveBrand(brand, title);
    if (after.toLowerCase() !== brand.trim().toLowerCase()) flips++;
  }
  return flips;
}

/** AC-2 metric: does the RENDERED brand line agree with the brand the title
 *  shows? Agreement = the resolved brand appears as a word inside the title
 *  (case-insensitive). Empty brand lines are neutral, not disagreements. */
function titleAgreement(pairs) {
  let agree = 0;
  let blank = 0;
  const residual = [];
  for (const { title, brand } of pairs) {
    const after = resolveBrand(brand, title);
    if (after === "") {
      blank++;
      continue;
    }
    const t = title.toLowerCase();
    const b = after.toLowerCase();
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\\p{L}\\p{N}])`, "iu");
    if (re.test(t)) agree++;
    else residual.push(`${JSON.stringify(after)} vs "${title.slice(0, 50)}"`);
  }
  return { agree, blank, residual };
}

function report(name, pairs) {
  const flips = flipCount(pairs);
  console.log(`== ${name}: ${pairs.length} pairs, field-vs-title flips ${flips} (${pairs.length ? ((flips / pairs.length) * 100).toFixed(1) : "-"}%)`);
  let shown = 0;
  for (const { title, brand } of pairs) {
    const after = resolveBrand(brand, title);
    if (after.toLowerCase() !== brand.trim().toLowerCase() && shown < 3) {
      shown++;
      console.log(`   "${title.slice(0, 58)}" — before ${JSON.stringify(brand)} -> after ${JSON.stringify(after)}`);
    }
  }
  return pairs;
}

const quadra = await quadraPairs();
report("Quadra Stores", quadra);
const q = titleAgreement(quadra);
const graded = q.agree + q.residual.length;
console.log(`   Quadra AC-2 audit: ${graded + q.blank} items (${q.blank} blank brand lines), brand/title agreement ${q.agree}/${graded}${graded ? ` (${((q.agree / graded) * 100).toFixed(1)}%)` : ""}`);
for (const r of q.residual.slice(0, 8)) console.log(`   residual mismatch: ${r}`);

report("Xcite", await xcitePairs());
report("Jarir", await jarirPairs());
report("Eureka", await eurekaPairs());
report("Sultan Center", await sultanPairs());
report("Blink", await blinkPairs());
console.log('== Lulu Hypermarket / PC Kuwait: contract carries no brand field — brand line already comes from curatedBrandInTitle on the title; unchanged by the rule.');
console.log("== Next Store: scanner reads the card's brand anchor; resolveBrand applies the same rule at render (same helper).");
