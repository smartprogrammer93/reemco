/**
 * REEA-510 test hygiene — give every importing test file its OWN empty
 * collect-cache directory before any store module is evaluated. The shared
 * .collect-cache/ dir is written by real harness runs (last-seen snapshots
 * for the fixed query set); a test file that reads it would see rows from
 * whoever ran last and its length assertions would drift. Same isolation
 * pattern collect.test.ts / kv-store.test.ts already use, factored out so
 * static-import files get it at module-evaluation order: import this FIRST.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.COLLECT_CACHE_DIR = mkdtempSync(join(tmpdir(), "reemco-test-cache-"));

export {};
