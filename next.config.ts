import type { NextConfig } from "next";

const nextConfig: NextConfig =
  // STATIC_EXPORT=1 ships keyless static builds (surge.sh preview). The
  // default is a server build so the REEA-37 funnel endpoints under
  // /api/events are served (Vercel/`next start`).
  process.env.STATIC_EXPORT === "1" ? { output: "export" } : {};

export default nextConfig;
