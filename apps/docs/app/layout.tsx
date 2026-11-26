import type { Metadata, Viewport } from "next"
import { headers } from "next/headers"
import { Geist, Geist_Mono } from "next/font/google"
import config from "@/config/config.json"
import "./globals.css"
import { ThemeProvider } from "@sendcms/ui"
import { Toaster } from "@sendcms/ui"

export const metadata: Metadata = {
  title: "Documentation — SendCMS",
  description:
    "Guides and references for SendCMS — setup, the SDK, the REST API, and embedding.",
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

const fontSans = Geist({
  subsets: ["latin"],
  variable: "--font-sans",
})

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // CSP nonce (Admin Control Plane, Phase 9): the proxy sets `x-nonce`
  // on the request, and the inline theme script next-themes renders
  // needs that nonce on its `<script>` tag or the enforcing policy
  // blocks it. Next.js only nonces its own scripts — this one has to
  // be threaded through explicitly. No proxy ran (unmatched route) →
  // no nonce, and no CSP header on that response either.
  const nonce = (await headers()).get("x-nonce") ?? undefined

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${fontSans.variable} ${fontMono.variable} font-sans antialiased`}
    >
      {/* Meta Informations */}
      {/* Favicon */}
      <link rel="icon" type="image/png" href={config.site.favicon} />
      <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      <link rel="manifest" href="/manifest.webmanifest" />

      <body suppressHydrationWarning>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow"
        >
          Skip to main content
        </a>
        <ThemeProvider nonce={nonce}>
          {children}
          <Toaster richColors position="top-right" />
        </ThemeProvider>
      </body>
    </html>
  )
}
