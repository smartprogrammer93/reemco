// Resolve the "@/..." TS path alias to ./src/... so node --test can run the
// TypeScript sources directly (node --experimental-strip-types).
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

const SRC = "/work/reemco-price-compare/src";

async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const base = specifier.slice(2);
    for (const ext of [".ts", "/index.ts"]) {
      const abs = `${SRC}/${base}${ext}`;
      if (existsSync(abs)) {
        return { url: pathToFileURL(abs).href, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}

register("./alias-hook.mjs", pathToFileURL("/work/scratch/").href);
export { resolve };
