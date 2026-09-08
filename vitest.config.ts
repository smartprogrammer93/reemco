import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    include: ["src/*.test.ts", "src/lib/**/*.test.ts", "src/lib/**/*.test.tsx", "src/components/*.test.tsx", "src/app/*.test.ts"],
  },
});
