import path from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      // Mirror tsconfig paths (@/* -> repo root) so tests import like app code.
      "@": path.resolve(import.meta.dirname, "./"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
})
