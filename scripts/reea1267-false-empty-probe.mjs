/**
 * REEA-1267 (Bet 2) — false-empty escape probe (committed, QA-replayable).
 *
 * Replays the fixed 10-case filter panel against the SERVED results page in
 * EN and AR and asserts:
 *   - 0 false-empties: no case where the served page presents the no-match
 *     state while the payload it carries holds ≥1 confident in-scope match the
 *     active default filter is hiding;
 *   - the escape line renders with N equal to the payload-derived hidden count
 *     and a one-tap control, on every case that still hides ≥1 match;
 *   - the escape's count is derived from the SAME painted shelf chain the
 *     renderer uses (src/lib/results-shelf.ts + src/lib/hidden-matches.ts), so
 *     N is the count the reveal actually adds — never a relabelled server
 *     number and never a `related`-band row promoted into it (F-2).
 *
 * Usage (no args, no browser):
 *   node scripts/reea1267-false-empty-probe.mjs
 *   BASE_URL=https://ns539626.ip-144-217-72.net OUT=/tmp/reea1267-probe.json \
 *     node scripts/reea1267-false-empty-probe.mjs
 *
 * It prints the served stamp (`/__commit.txt` + `/api/health`) BEFORE running.
 * The viewport column records the two QA widths this panel is verified at
 * (375/1280). The served document is viewport-independent, so the probe reads
 * the same DOM contract for both; horizontal overflow / above-the-fold layout
 * shift are browser-only and belong to QA's pass on the same head.
 *
 * Live data drifts: a case that no longer hides anything is reported as
 * "ok (nothing hidden now)" and does not fail. The panel must keep at least
 * one hiding case so the probe cannot pass vacuously.
 */
import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

const BASE = (process.env.BASE_URL || "https://ns539626.ip-144-217-72.net").replace(/\/$/, "");
const OUT = process.env.OUT || "/tmp/reea1267-probe.json";
const LOCALES = ["en", "ar"];
const VIEWPORTS = [375, 1280];

/**
 * The fixed 10-case panel. Each row is a real shopper-shaped query whose live
 * payload carried a confident in-scope product the default In stock filter
 * hides (out-of-stock listing). Measured on the served head when this ticket
 * was executed; `filter` is the active selection that hides the match.
 */
const PANEL = [
  { query: "ipad keyboard", filter: "stock", note: "full hiding: shelf empty, 1 confident card behind In stock" },
  { query: "ipad cover", filter: "stock", note: "partial: 5 confident cards behind In stock" },
  { query: "ipad keyboard case", filter: "stock", note: "partial: 3 confident cards behind In stock" },
  { query: "iphone 17 pro case", filter: "stock", note: "partial: 2 confident cards behind In stock" },
  { query: "macbook air case", filter: "stock", note: "partial: 1 confident card behind In stock" },
  { query: "coffee machine", filter: "stock", note: "partial: 2 confident cards behind In stock" },
  { query: "refrigerator", filter: "stock", note: "partial: 1 confident card behind In stock" },
  { query: "iphone 17 pro", filter: "stock", note: "partial: 1 confident card behind In stock" },
  { query: "nintendo switch 2", filter: "stock", note: "partial: 1 confident card behind In stock" },
  { query: "braun shaver", filter: "stock", note: "partial: 1 confident card behind In stock" },
];

/* ---- Resolve the app's own TypeScript modules (one definition, no copy). ---- */
const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = resolvePath(ROOT, "src");
const HOOK = `
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
const SRC = ${JSON.stringify(SRC)};
function tryFile(abs) {
  for (const ext of [".ts", ".tsx", "/index.ts"]) {
    if (existsSync(abs + ext)) return pathToFileURL(abs + ext).href;
  }
  return null;
}
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const url = tryFile(SRC + "/" + specifier.slice(2));
    if (url) return { url, shortCircuit: true };
  } else if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\\.[a-z]+$/i.test(specifier)) {
    const parent = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : SRC;
    const url = tryFile(resolvePath(parent, specifier));
    if (url) return { url, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;
register("data:text/javascript," + encodeURIComponent(HOOK));

let shelf;
let hiddenMatches;
try {
  shelf = await import(pathToFileURL(resolvePath(SRC, "lib/results-shelf.ts")).href);
  hiddenMatches = await import(pathToFileURL(resolvePath(SRC, "lib/hidden-matches.ts")).href);
} catch (error) {
  console.error(
    "FAIL: could not load the app's TypeScript modules. Node >= 22.18 (type stripping) is required.\n" +
      String(error),
  );
  process.exit(1);
}

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/* ---- served stamp first, as F-4 requires. ---- */
const rawStamp = await fetch(`${BASE}/__commit.txt`).then((r) => r.text()).catch(() => null);
const health = await fetch(`${BASE}/api/health`)
  .then((r) => r.json())
  .catch(() => null);
// A self-hosted box answers /__commit.txt with the served SHA. A local
// `next start` has no such route (the 404 document comes back instead); the
// probe still runs and records the health build so a local replay is legible.
const stamp = rawStamp && /^[0-9a-f]{7,40}\s*$/i.test(rawStamp) ? rawStamp.trim() : null;
console.log(
  stamp
    ? `served stamp: ${stamp}`
    : `served stamp: (no /__commit.txt answer — health build: ${health?.build ?? "unknown"})`,
);
console.log(`health: ${JSON.stringify(health)}`);
if (!health || health.ok !== true) {
  console.error("FAIL: the health probe did not answer — cannot measure this head.");
  process.exit(1);
}

/** Parse the RSC flight payload the served document carries (its live snapshot). */
function payloadsFrom(html) {
  const chunks = [];
  const re = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let match;
  while ((match = re.exec(html))) {
    try {
      chunks.push(JSON.parse(match[1]));
    } catch {
      /* a split chunk that is not a complete JSON string — ignore */
    }
  }
  const flight = chunks.join("");
  const objects = [];
  for (const row of flight.split("\n")) {
    const colon = row.indexOf(":");
    if (colon < 0) continue;
    const body = row.slice(colon + 1);
    if (!body.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed.products)) objects.push(parsed);
    } catch {
      /* not a snapshot object */
    }
  }
  return objects;
}

function escapeFrom(html) {
  const count = (html.match(/data-hidden-count="(\d+)"/) || [])[1];
  const filter = (html.match(/data-hidden-filter="([a-z]+)"/) || [])[1] || null;
  const reveal = (html.match(/data-hidden-reveal="([a-z]+)"/) || [])[1] || null;
  const line = (html.match(/data-hidden-matches="true"[\s\S]*?<\/div>/) || [])[0] || "";
  return {
    present: count != null,
    count: count == null ? null : Number(count),
    filter,
    reveal,
    text: line.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
  };
}

function shelfFrom(html) {
  const ids = [...html.matchAll(/data-product-id="([^"]+)"/g)].map((m) => m[1]);
  return { cards: ids.length, ids };
}

function emptyCaseFrom(html) {
  return (html.match(/data-empty-case="([a-c])"/) || [])[1] || null;
}

const rows = [];
const failures = [];

for (const item of PANEL) {
  for (const locale of LOCALES) {
    const url = `${BASE}/results?q=${encodeURIComponent(item.query)}&market=KW`;
    let html;
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": UA,
          ...(locale === "ar" ? { cookie: "rc_locale=ar" } : {}),
        },
      });
      html = await response.text();
    } catch (error) {
      failures.push(`${item.query}/${locale}: fetch failed (${String(error).slice(0, 120)})`);
      continue;
    }
    const payloads = payloadsFrom(html);
    const snapshot = payloads.length > 0 ? payloads[payloads.length - 1] : null;
    const rendered = shelfFrom(html);
    const escape = escapeFrom(html);
    const emptyCase = emptyCaseFrom(html);

    if (!snapshot) {
      rows.push({
        query: item.query,
        locale,
        viewports: VIEWPORTS,
        hidden: null,
        rendered: rendered.cards,
        escape,
        emptyCase,
        verdict: "no payload (serve carried no snapshot)",
      });
      continue;
    }

    const products = snapshot.products;
    // Every snapshot the served document streamed (earlier flushes paint from
    // their own stage snapshot); the rendered shelf must still be made only of
    // payload rows from this run.
    const payloadIds = new Set();
    for (const payload of payloads) {
      for (const product of payload.products) payloadIds.add(product.productId);
    }
    // The TRUE hidden set: the payload's confident in-scope cards the active
    // filter removes from the SAME painted shelf chain the page renders.
    const hidden = hiddenMatches.hiddenShelfMatches(products, item.query, 1, "KW", false);
    const withFilterOn = shelf.paintedShelfFromProducts(products, item.query, 1, "KW", false);
    const withFilterOff = shelf.paintedShelfFromProducts(products, item.query, 1, "KW", true);
    const hiddenIds = hidden.cards.map((p) => p.productId);
    const visibleIds = withFilterOn.map((p) => p.productId);
    const falseEmpty =
      withFilterOn.length === 0 && hidden.cards.length > 0 && (!escape.present || escape.count === 0);

    const problems = [];
    if (falseEmpty) {
      problems.push(
        `FALSE-EMPTY: shelf empty, ${hidden.cards.length} confident card(s) hidden, no escape rendered (empty-case ${emptyCase})`,
      );
    }
    if (hidden.cards.length > 0 && !escape.present) {
      problems.push(`escape missing while ${hidden.cards.length} match(es) are hidden`);
    }
    if (hidden.cards.length > 0 && escape.present && escape.count !== hidden.cards.length) {
      problems.push(
        `escape count ${escape.count} != payload hidden count ${hidden.cards.length}`,
      );
    }
    if (hidden.cards.length > 0 && escape.present && escape.reveal == null) {
      problems.push("escape has no one-tap reveal control");
    }
    if (hidden.cards.length > 0 && escape.present && escape.filter !== item.filter) {
      problems.push(`escape names filter ${escape.filter}, expected ${item.filter}`);
    }
    if (hidden.cards.length > 0 && escape.present && locale === "ar" && !/مخفية|مخفي/.test(escape.text)) {
      problems.push(`Arabic escape is not the Arabic copy: ${escape.text}`);
    }
    if (hidden.cards.length > 0 && escape.present && locale === "en" && !/hidden by/i.test(escape.text)) {
      problems.push(`English escape is not the English copy: ${escape.text}`);
    }
    // F-2 — the hidden set must be the payload's confident in-scope cards: no
    // `related`/`accessory` row promoted into it.
    for (const card of hidden.cards) {
      if (card.productScope != null && card.productScope !== "primary" && card.productScope !== "variant") {
        problems.push(`hidden card ${card.productId} carries scope ${card.productScope}`);
      }
      if (!withFilterOff.some((p) => p.productId === card.productId)) {
        problems.push(`hidden card ${card.productId} is not on the filter-off painted shelf`);
      }
    }
    // The rendered shelf must be the payload's filtered painted shelf (no
    // fabricated rows): every rendered id comes from the payload.
    for (const id of rendered.ids) {
      if (!payloadIds.has(id)) problems.push(`rendered card ${id} is not in the payload`);
    }

    const verdict =
      problems.length === 0
        ? hidden.cards.length > 0
          ? "PASS — escape present with the true count"
          : "ok (nothing hidden now)"
        : "FAIL";
    if (problems.length > 0) failures.push(`${item.query}/${locale}: ${problems.join("; ")}`);

    rows.push({
      query: item.query,
      locale,
      viewports: VIEWPORTS,
      filter: item.filter,
      note: item.note,
      payloadProducts: products.length,
      rendered: rendered.cards,
      paintedWithFilterOn: withFilterOn.length,
      paintedWithFilterOff: withFilterOff.length,
      hidden: hidden.cards.length,
      hiddenIds,
      visibleIds,
      escape,
      emptyCase,
      verdict,
      problems,
    });
    console.log(
      `${item.query} ${locale} @${VIEWPORTS.join("/")}: rendered=${rendered.cards} ` +
        `painted(on/off)=${withFilterOn.length}/${withFilterOff.length} hidden=${hidden.cards.length} ` +
        `escape=${escape.present ? `${escape.count}/${escape.filter}/${escape.reveal}` : "none"} ` +
        `empty-case=${emptyCase ?? "none"} ${verdict}`,
    );
  }
}

const hiding = rows.filter((r) => (r.hidden ?? 0) > 0);
const falseEmpties = rows.filter(
  (r) =>
    r.hidden != null &&
    r.paintedWithFilterOn === 0 &&
    r.hidden > 0 &&
    (!r.escape.present || r.escape.count === 0),
);

const report = {
  stamp,
  health,
  generatedAt: new Date().toISOString(),
  base: BASE,
  viewports: VIEWPORTS,
  locales: LOCALES,
  panel: PANEL,
  runs: rows.length,
  hidingRuns: hiding.length,
  falseEmpties: falseEmpties.length,
  failures,
  rows,
};
writeFileSync(OUT, JSON.stringify(report, null, 2));

console.log(
  `\nPANEL: ${PANEL.length} cases × ${LOCALES.length} locales = ${rows.length} runs; ` +
    `still hiding=${hiding.length}; false-empties=${falseEmpties.length}; failures=${failures.length}`,
);
console.log(`wrote ${OUT}`);

if (failures.length > 0) {
  console.error("\nFAIL:", failures.join("\n"));
  process.exit(1);
}
if (hiding.length === 0) {
  console.error("\nFAIL: the panel hides nothing on this head — refresh the 10-case panel; the probe cannot pass vacuously.");
  process.exit(1);
}
console.log("OK: 0 false-empties; every hiding case renders the escape with the payload-derived count.");
