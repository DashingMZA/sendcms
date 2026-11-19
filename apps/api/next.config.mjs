import path from "path"
import { fileURLToPath } from "url"

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
  ],
  turbopack: {
    root: workspaceRoot,
  },
}

export default nextConfig
