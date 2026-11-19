import { defineConfig, globalIgnores } from "eslint/config"
import baseConfig from "@sendcms/config/eslint/base.mjs"

const eslintConfig = defineConfig([
  // Shared SendCMS base (Next.js presets from @sendcms/config).
  ...baseConfig,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
])

export default eslintConfig
