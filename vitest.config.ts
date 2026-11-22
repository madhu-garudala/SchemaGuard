import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    globalSetup: ["tests/global-setup.ts"],
    env: {
      SCHEMA_GUARD_TEST: "1",
      DATABASE_URL: "postgres://schema_guard:schema_guard@127.0.0.1:54329/schema_guard_test",
      SCHEMA_GUARD_RUNTIME_DIR: ".runtime-test",
      AGENT_MODE: "fixture",
    },
  },
});
