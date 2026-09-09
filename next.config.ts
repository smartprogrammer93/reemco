import type { NextConfig } from "next";

// REEA-437 — jsdom backs the Cloudflare-clearance hop inside
// collect/live-search.ts (server-side only). Declaring it external keeps
// Turbopack on native `require` for jsdom instead of tracing its Node `fs`
// internals into the browser bundle the results page ships.
const shared = { serverExternalPackages: ["jsdom"] } satisfies Partial<NextConfig>;

const nextConfig: NextConfig =
  // STATIC_EXPORT=1 ships a static snapshot for offline checks. The default
  // is the production server build (reemco.vercel.app on Vercel, or
  // `next start`) so the REEA-37 funnel endpoints under /api/events are served.
  process.env.STATIC_EXPORT === "1" ? { ...shared, output: "export" } : shared;

export default nextConfig;
