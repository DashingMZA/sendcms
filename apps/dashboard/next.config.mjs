import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Turbopack's filesystem root must be the WORKSPACE root (where the
// lockfile lives), not this app's dir — otherwise it cannot resolve
// `next` or the @sendcms/* workspace packages, which live outside
// apps/dashboard. See ADR 0004.
const workspaceRoot = path.resolve(__dirname, "../..")

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@sendcms/shared",
    "@sendcms/ui",
    "@sendcms/database",
    "@sendcms/auth",
    "@sendcms/permissions",
    "@sendcms/email",
    "@sendcms/api-client",
    "@sendcms/sdk",
    "@sendcms/domains",
    "@sendcms/forms",
    "@sendcms/inbox",
    "@sendcms/notifications",
    "@sendcms/users",
    "@sendcms/analytics",
  ],
  turbopack: {
    root: workspaceRoot,
  },
}

export default nextConfig
