// Per-app OpenNext config (Phase 10) — re-exports the shared
// R2-cache config from infrastructure/cloudflare/. The build runs
// from this app's directory, and OpenNext loads this file from here.
export { default } from "../../infrastructure/cloudflare/open-next.config"
