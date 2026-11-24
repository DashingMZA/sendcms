import type { Metadata } from "next"

export const metadata: Metadata = {
  // The api app serves route handlers, not pages — nothing here is
  // for crawlers (Phase 16, PRF-034). Defence in depth alongside
  // robots.ts and the `X-Robots-Tag` header in next.config.mjs.
  robots: { index: false, follow: false },
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
