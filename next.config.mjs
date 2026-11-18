import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: [
    "@sendcms/shared",
    "@sendcms/ui",
    "@sendcms/domains",
    "@sendcms/forms",
    "@sendcms/submissions",
    "@sendcms/inbox",
    "@sendcms/notifications",
    "@sendcms/users",
    "@sendcms/analytics",
  ],
  turbopack: {
    root: __dirname,
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "i.pravatar.cc",
        pathname: "/**",
      },
    ],
  },
}

export default nextConfig
