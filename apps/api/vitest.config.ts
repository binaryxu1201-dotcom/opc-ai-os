import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
    hookTimeout: 15000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/server.ts", "src/platform/request-context.ts"],
      thresholds: {
        lines: 60,
        branches: 60,
        functions: 60,
        statements: 60
      }
    }
  }
});
