import type { NextConfig } from "next";

const nextConfig: NextConfig =
  // STATIC_EXPORT=1 ships a static snapshot for offline checks. The default
  // is the production server build (reemco.vercel.app on Vercel, or
  // `next start`) so the REEA-37 funnel endpoints under /api/events are served.
  process.env.STATIC_EXPORT === "1" ? { output: "export" } : {};

export default nextConfig;
