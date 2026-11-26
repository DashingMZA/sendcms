import type { Metadata, Viewport } from "next"

export const metadata: Metadata = {
  // The api app serves route handlers, not pages — nothing here is
  // for crawlers (Phase 16, PRF-034). Defence in depth alongside
  // robots.ts and the `X-Robots-Tag` header in next.config.mjs.
  robots: { index: false, follow: false },
}

// Brand theme color (PRF-040): the light/dark pair tracks --primary,
// so the browser chrome matches the app in both themes.
export const viewport: Viewport = {
  themeColor: [
    {
      media: "(prefers-color-scheme: light)",
      color: "oklch(0.6373 0.1362 162.517)",
    },
    {
      media: "(prefers-color-scheme: dark)",
      color: "oklch(0.7678 0.1655 162.189)",
    },
  ],
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      <link rel="manifest" href="/manifest.webmanifest" />
      <body>{children}</body>
    </html>
  )
}
