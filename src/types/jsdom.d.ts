// Ambient declaration for the jsdom runtime used by the Cloudflare-clearance
// hop in collect/live-search.ts. jsdom ships no bundled types here and the
// hop only touches a handful of plain properties, so an any-typed module
// keeps `tsc --noEmit` (and with it `next build`) green without dragging a
// second @types package into the dev tree. REEA-437 — the results-page cold
// start work requires the production build to complete.
declare module "jsdom";
