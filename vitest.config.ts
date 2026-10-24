import { defineConfig } from "vitest/config";

export default defineConfig({
  ssr: {
    external: ["node:sqlite"]
  },
  test: {
    include: ["packages/**/test/**/*.test.ts"],
    environment: "node",
    globals: false,
    testTimeout: 15000
  }
});
