import type { Metadata, Viewport } from "next"
import { headers } from "next/headers"
import { Geist, Geist_Mono } from "next/font/google"
import config from "@/config/config.json"
import "./globals.css"
import { ThemeProvider } from "@sendcms/ui"
import { getBaseUrl } from "@/lib/utils"

const baseUrl = getBaseUrl()

export const metadata: Metadata = {
  // PRF-031/032 (Wave 11, Stream C): metadataBase makes every relative
  // metadata URL (canonicals, og:url, og:image) resolve to an absolute
  // URL. The layout sets the shared Open Graph / Twitter defaults;
  // each page adds its own canonical + og:url via pageOpenGraph() in
  // @/lib/utils — a page openGraph REPLACES the layout's wholesale,
  // so pages must repeat the shared fields (siteName/locale/images).
  // No `twitter:site`/`twitter:creator`: SendCMS has no X handle
  // anywhere in the repo — do not invent one.
  metadataBase: new URL(baseUrl),
  title: "Changelog — SendCMS",
  description: "What's new in SendCMS. Notes from each release.",
  openGraph: {
    siteName: "SendCMS",
    locale: "en_US",
    type: "website",
    images: [
      {
        url: `${baseUrl}${config.metadata.meta_image}`,
        width: 1200,
        height: 630,
        alt: "SendCMS changelog",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
  },
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
        {/* PRF-007 (Wave 11): no Toaster component in the public apps — no
            toast() call site exists in this app, so the sonner bundle
            was dead weight on every page. Dashboard/admin keep theirs. */}
        <ThemeProvider nonce={nonce}>{children}</ThemeProvider>
      </body>
    </html>
  )
}
