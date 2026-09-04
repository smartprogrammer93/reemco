import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Static export lets us ship keyless preview builds (e.g. surge.sh) while
  // the Vercel pipeline handles production/PR previews.
  output: "export",
};

export default nextConfig;
