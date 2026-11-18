import { defineConfig } from "eslint/config"
import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"

// Shared SendCMS ESLint base: the Next.js presets. Apps extend this and add
// their own ignores (build output, generated files, worktrees).
export default defineConfig([...nextVitals, ...nextTs])
