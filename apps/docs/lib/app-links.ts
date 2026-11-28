// Cross-app links — single source is `@sendcms/shared` (SRC-120,
// Phase 16, Wave 12). This file re-exports it so existing
// `@/lib/app-links` imports keep working; do not add helpers here.
// The docs pages' "home" links point back at the public site, which
// lives in the marketing app.
export {
  adminUrl,
  apiUrl,
  dashboardUrl,
  docsUrl,
  marketingTermsURL,
  marketingUrl,
  resolveLink,
  updatesUrl,
} from "@sendcms/shared"
