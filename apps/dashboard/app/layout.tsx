import type { Metadata, Viewport } from "next"
import { headers } from "next/headers"
import { Geist, Geist_Mono } from "next/font/google"
import config from "@/config/config.json"
import "./globals.css"
import { DirectionProvider, ThemeProvider, Toaster } from "@sendcms/ui"
import { auth } from "@/lib/auth"
import { getLocaleDirection, getRequestLocale, getTranslator } from "@/lib/i18n"

export const metadata: Metadata = {
  title: "SendCMS Dashboard",
  description:
    "Manage your SendCMS domains, forms, and submissions — view the inbox, check analytics, and get the embed snippet.",
  // Authenticated app — nothing here is for crawlers (Phase 16,
  // PRF-034). Defence in depth alongside robots.ts and the
  // `X-Robots-Tag` header in next.config.mjs.
  robots: { index: false, follow: false },
  // PRF-040: the PWA manifest (Stream C owns the asset) and the
  // Apple touch icon, so the dashboard installs cleanly.
  manifest: "/manifest.webmanifest",
  icons: { apple: "/apple-touch-icon.png" },
}

// PRF-040: the browser-chrome theme colour, light and dark.
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

  // The dashboard's language comes from the `sendcms-locale` cookie
  // (set by the sidebar language selector, or by the stored user
  // preference). English is the fallback; `ur` renders right-to-left.
  // The session user id is passed (DSH-001/DSH-201/DSH-401) so the
  // stored DB preference resolves for the shell too — without it, a
  // user with stored `ur` and no cookie got Urdu page content inside
  // an English LTR `<html>` with the sidebar on the left. Signed-out
  // visitors have no session, so only the cookie applies to them.
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const direction = getLocaleDirection(locale)
  // Chrome strings (skip link, toast live-region label) come from the
  // shared `common` domain so they follow the page locale (I18N-101,
  // I18N-105) instead of rendering hardcoded English.
  const t = await getTranslator(locale, "common")

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
          className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus:rounded focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow"
        >
          {t("skipToContent")}
        </a>
        <DirectionProvider dir={direction}>
          <ThemeProvider nonce={nonce}>
            {children}
            <Toaster
              richColors
              position="top-right"
              containerAriaLabel={t("notifications")}
            />
          </ThemeProvider>
        </DirectionProvider>
      </body>
    </html>
  )
}
