import path from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      // App code imports its own lib as @/lib/* (apps/api/tsconfig
      // maps @/* to apps/api/*); under vitest @/* means the repo
      // root, so @/lib/* needs its own entry or route tests cannot
      // load apps/api route modules at all. No trailing slash on the
      // key: the alias matcher requires the next character to be "/".
      "@/lib": path.resolve(import.meta.dirname, "./apps/api/lib"),
      // Mirror tsconfig paths (@/* -> repo root) so tests import like app code.
      "@": path.resolve(import.meta.dirname, "./"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // TST-002 (Phase 16, Wave 12): coverage was never configured —
    // no provider, no thresholds, no script, no CI step, so no
    // coverage number existed at all. Provider @vitest/coverage-v8
    // (devDependency, 5.x to match vitest 5.x). `include` covers the
    // code the suites exercise: the api app + every package/module
    // src tree. Generated Prisma output, configs, and the tests
    // themselves are excluded. Thresholds are the measured Wave 12
    // baseline rounded down (full suite 2026-11-27: lines 63.18,
    // statements 61.5, functions 52.57, branches 64.57; 2308 tests
    // passed, 16 skipped) so the gate fails on a coverage regression
    // without going red on the baseline itself.
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      include: [
        "apps/api/**/*.{ts,tsx}",
        "packages/*/src/**/*.{ts,tsx}",
        "packages/modules/*/src/**/*.{ts,tsx}",
      ],
      exclude: [
        "packages/database/generated/**",
        "packages/*/src/**/*.d.ts",
        "packages/modules/*/src/**/*.d.ts",
        "apps/api/**/*.d.ts",
        "**/*.test.ts",
        "**/*.test.tsx",
        "e2e/**",
        "scripts/**",
      ],
      thresholds: {
        lines: 60,
        branches: 60,
        functions: 50,
        statements: 60,
      },
    },
  },
})
