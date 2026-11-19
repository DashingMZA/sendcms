import path from "path"
import { fileURLToPath } from "url"
import { securityHeaders } from "../../packages/security/src/headers.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Turbopack's filesystem root must be the WORKSPACE root (where the
// lockfile lives), not this app's dir — otherwise it cannot resolve
// `next` or the @sendcms/* workspace packages, which live outside
// apps/api. See the turbopack.root docs.
const workspaceRoot = path.resolve(__dirname, "../..")

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@sendcms/shared",
    "@sendcms/api-client",
    "@sendcms/database",
    "@sendcms/auth",
    "@sendcms/permissions",
    "@sendcms/email",
    "@sendcms/domains",
    "@sendcms/forms",
    "@sendcms/submissions",
    "@sendcms/inbox",
    "@sendcms/notifications",
    "@sendcms/observability",
    "@sendcms/security",
  ],
  turbopack: {
    root: workspaceRoot,
  },
  // Security headers (Phase 10): the shared definition lives in
  // packages/security/src/headers.mjs — imported by relative path
  // because plain Node (which loads this config) cannot import
  // TypeScript. The matching `public/_headers` file covers static
  // assets on Cloudflare's asset layer.
  async headers() {
    return securityHeaders()
  },
}

export default nextConfig
