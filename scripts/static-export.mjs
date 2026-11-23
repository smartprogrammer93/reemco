/**
 * REEA-30 deploy fix — static export excludes server-only API routes.
 *
 * `output: "export"` cannot ship route handlers that are force-dynamic or
 * read the incoming Request (e.g. /api/events/report, REEA-37). Those
 * routes are meaningless on a static host anyway, so this script
 * temporarily renames them out of the build, runs `next build`, and
 * always restores them.
 *
 * REEA-1088 — the old hand-maintained route list had drifted twice over
 * (REEA-1063's collect-rate-limit test, REEA-870's collect test, then the
 * /api/metrics and /api/health handlers were added as force-dynamic), and
 * `npm run build:static` was failing before it could emit any HTML: first a
 * type check "Cannot find module '@/app/api/.../route'", then
 * `export const dynamic = "force-dynamic" ... cannot be used with "output:
 * export"`. The static snapshot is the only lane that exercises the
 * STATIC_EXPORT meta-CSP fallback in src/app/layout.tsx, so a broken static
 * build silently hid that fallback from every check. Derive the lists from the
 * tree instead of listing them by hand:
 *   - every `src/app/api/**\/route.ts` that exports force-dynamic;
 *   - every test file that imports an app/api module, because `next build`
 *     typechecks tests and the imported module is renamed away (REEA-77).
 *
 * Metadata routes (`src/app/sitemap.ts`, `src/app/robots.ts`) and the page
 * segments are force-dynamic on purpose (REEA-278/1051: the origin follows the
 * serving host; /results, /search and /product render per request). A static
 * export cannot carry a dynamic route, but the content is still meaningful
 * baked at build time, so this script rewrites every remaining force-dynamic
 * segment config to force-static for the build and restores the files
 * afterwards (REEMCO_SITE_ORIGIN, when set, names the snapshot's host).
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const FORCE_DYNAMIC_RE = /export\s+const\s+dynamic\s*=\s*["']force-dynamic["'];?/;

/** Recursively collect files under `dir` matching `match(absolutePath)`. */
function collect(dir, match, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(abs, match, out);
    } else if (match(abs)) {
      out.push(abs);
    }
  }
  return out;
}

const SERVER_ONLY_ROUTES = collect(path.join(root, "src", "app", "api"), (abs) => {
  if (path.basename(abs) !== "route.ts") return false;
  // Only force-dynamic handlers have to leave a static export. A route that
  // does NOT export force-dynamic (and does not read the request) is static
  // and can ship.
  return FORCE_DYNAMIC_RE.test(readFileSync(abs, "utf8"));
});

const TEST_FILES_IMPORTING_SERVER_ROUTES = collect(
  path.join(root, "src"),
  (abs) =>
    /\.test\.tsx?$/.test(abs) &&
    // Static `from "@/app/api/..."` and dynamic `await import("@/app/api/...")`.
    /(?:from\s+|import\()\s*["'][^"']*app\/api\//.test(readFileSync(abs, "utf8")),
);

// The metadata routes below lose their `dynamic` export for this build, and
// src/app/metadata.test.ts asserts that export exists, so it must sit out the
// type check too.
const TEST_FILES_IMPORTING_METADATA_ROUTES = collect(
  path.join(root, "src"),
  (abs) =>
    /\.test\.tsx?$/.test(abs) &&
    /(?:from\s+|import\()\s*["'][^"']*app\/(?:sitemap|robots)["']/.test(readFileSync(abs, "utf8")),
);

const renamed = [];
for (const abs of [
  ...SERVER_ONLY_ROUTES,
  ...TEST_FILES_IMPORTING_SERVER_ROUTES,
  ...TEST_FILES_IMPORTING_METADATA_ROUTES,
]) {
  renameSync(abs, `${abs}.server-only`);
  renamed.push(abs);
}

// REEA-1088 — `output: export` also refuses force-dynamic PAGES (results,
// search, product/[productId], sitemap/robots). The static snapshot has no
// server, so every remaining route that still declares force-dynamic is
// rewritten to force-static for the duration of the build and restored
// afterwards. Those pages already guard their request-time reads with
// try/catch and fall back to defaults, so force-static renders them the same
// way the static host would.
//
// A force-dynamic page that also exports `generateMetadata` reading
// searchParams (/results) is still classified dynamic by the export build and
// gets skipped — verified: with the export dropped, /results is emitted as a
// static page. For those snapshot pages we drop the `export` keyword for the
// build (the page then inherits the root layout's metadata) and restore the
// file afterwards. A static page that exports generateMetadata (home) keeps it.
const GENERATE_METADATA_EXPORT_RE =
  /export\s+((?:async\s+)?function\s+generateMetadata)\s*\(/;

const rewritten = [];
for (const abs of collect(
  path.join(root, "src", "app"),
  (file) => /\.(?:ts|tsx)$/.test(file) && FORCE_DYNAMIC_RE.test(readFileSync(file, "utf8")),
)) {
  const original = readFileSync(abs, "utf8");
  const transformed = original
    .replace(FORCE_DYNAMIC_RE, 'export const dynamic = "force-static";')
    .replace(GENERATE_METADATA_EXPORT_RE, "$1(");
  writeFileSync(abs, transformed);
  rewritten.push([abs, original]);
}

try {
  console.log(
    `static export: ${renamed.length} server-only/test file(s) renamed out, ` +
      `${rewritten.length} route file(s) rewritten for static rendering` +
      (rewritten.length
        ? `: ${rewritten.map(([abs]) => path.relative(root, abs)).join(", ")}`
        : ""),
  );
  const result = spawnSync("npx", ["next", "build"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, STATIC_EXPORT: "1" },
  });
  process.exitCode = result.status ?? 1;
} finally {
  for (const abs of renamed) renameSync(`${abs}.server-only`, abs);
  for (const [abs, original] of rewritten) writeFileSync(abs, original);
}
