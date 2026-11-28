// Shared PostCSS config (Tailwind) — all apps resolve it by walking up
// from their CSS. No JSDoc type annotation on purpose: the only
// accurate one (`postcss-load-config`) is not a declared dependency
// (Phase 16, SRC-414), and the config shape is trivial without it.
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
}

export default config
