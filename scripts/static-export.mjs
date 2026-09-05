/**
 * REEA-30 deploy fix — static export excludes server-only API routes.
 *
 * `output: "export"` cannot ship route handlers that are force-dynamic or
 * read the incoming Request (e.g. /api/events/report, REEA-37). Those
 * routes are meaningless on a static host anyway, so this script
 * temporarily renames them out of the build, runs `next build`, and
 * always restores them.
 */
import { spawnSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const SERVER_ONLY_ROUTES = ["src/app/api/events/route.ts",
  "src/app/api/events/report/route.ts",
  "src/app/api/csp-report/route.ts"]; // REEA-74

// Test files that import a server-only route module: `next build` typechecks
// them, so they must be renamed out together with the route (REEA-77).
const TEST_FILES_IMPORTING_SERVER_ROUTES = ["src/proxy.test.ts"];

const renamed = [];
for (const rel of [...SERVER_ONLY_ROUTES, ...TEST_FILES_IMPORTING_SERVER_ROUTES]) {
  const abs = path.join(root, rel);
  if (existsSync(abs)) {
    renameSync(abs, `${abs}.server-only`);
    renamed.push(abs);
  }
}

try {
  const result = spawnSync("npx", ["next", "build"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, STATIC_EXPORT: "1" },
  });
  process.exitCode = result.status ?? 1;
} finally {
  for (const abs of renamed) renameSync(`${abs}.server-only`, abs);
}
