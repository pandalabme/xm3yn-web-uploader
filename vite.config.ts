import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "./",
  build: {
    // The available test phone runs Chrome 78. Keep the production bundle
    // within its native ESM baseline; Vite's development client itself
    // intentionally targets newer browsers, so phones use `npm run phone`.
    target: "chrome78",
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});

