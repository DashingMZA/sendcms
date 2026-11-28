// Cross-app links — single source is `@sendcms/shared` (SRC-120,
// Phase 16, Wave 12). This file re-exports it so existing
// `@/lib/app-links` imports keep working; do not add helpers here.
// (DSH-006: the dashboard sidebar links to `docsUrl()` so a signed-in
// user always has an in-app path to the docs.)
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
