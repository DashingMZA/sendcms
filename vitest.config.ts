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
  },
})
