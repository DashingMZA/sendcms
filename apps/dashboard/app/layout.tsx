import type { Metadata } from "next"
import { headers } from "next/headers"
import { Geist, Geist_Mono } from "next/font/google"
import config from "@/config/config.json"
import "./globals.css"
import { ThemeProvider, Toaster } from "@sendcms/ui"
import { getLocaleDirection, getRequestLocale } from "@/lib/i18n"

export const metadata: Metadata = {
  title: "SendCMS Dashboard",
  description:
    "Manage your SendCMS domains, forms, and submissions — view the inbox, check analytics, and get the embed snippet.",
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

  // The dashboard's language comes from the `sendcms-locale` cookie
  // (set by the sidebar language selector, or by the stored user
  // preference). English is the fallback; `ur` renders right-to-left.
  const locale = await getRequestLocale()
  const direction = getLocaleDirection(locale)

  return (
    <html
      lang={locale}
      dir={direction}
      suppressHydrationWarning
      className={`${fontSans.variable} ${fontMono.variable} font-sans antialiased`}
    >
      {/* Favicon */}
      <link rel="icon" type="image/png" href={config.site.favicon} />

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
