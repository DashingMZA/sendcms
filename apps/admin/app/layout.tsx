import type { Metadata, Viewport } from "next"
import { headers } from "next/headers"
import { Geist, Geist_Mono } from "next/font/google"
import config from "@/config/config.json"
import "./globals.css"
import { DirectionProvider, ThemeProvider, Toaster } from "@sendcms/ui"
import {
  SHELL_TRANSLATION_DOMAINS,
  getDictionaries,
  getLocaleDirection,
  getRequestLocale,
  getTranslator,
} from "@/lib/i18n"
import {
  LocaleProvider,
  TranslationProvider,
} from "@/components/admin/translation-provider"
import { QueryProvider } from "@/components/admin/query-provider"
import { LanguagePrompt } from "@/components/admin/language-prompt"
import { auth } from "@/lib/auth"

export const metadata: Metadata = {
  title: "SendCMS Admin",
  description:
    "SendCMS Admin Control Plane — manage users, plans, subscriptions, AI and MCP access, and platform operations.",
  // Authenticated app — nothing here is for crawlers (Phase 16,
  // PRF-034). Defence in depth alongside robots.ts and the
  // `X-Robots-Tag` header in next.config.mjs.
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
  // The admin's language comes from the `sendcms-locale` cookie (set by
  // the language prompt/selector, or by the stored user preference).
  // English is the fallback; `ur` renders right-to-left (`ar` is
  // registered as RTL too, but has no translation files yet).
  // The session user id is passed (I18N-203) so the stored DB
  // preference resolves for the shell too — without it, an admin with
  // stored `ur` and no cookie got English despite the preference the
  // UI itself had written. Signed-out visitors have no session, so
  // only the cookie applies to them.
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const direction = getLocaleDirection(locale)
  const dictionaries = await getDictionaries(locale, SHELL_TRANSLATION_DOMAINS)
  const t = await getTranslator(locale, "dashboard")
  // The toast live-region label lives in the shared `common` domain
  // (I18N-105) so it follows the page locale instead of rendering
  // Sonner's hardcoded English default.
  const tCommon = await getTranslator(locale, "common")
  // CSP nonce (Admin Control Plane, Phase 9): the proxy sets `x-nonce`
  // on the request, and the inline theme script next-themes renders
  // needs that nonce on its `<script>` tag or the enforcing policy
  // blocks it. Next.js only nonces its own scripts — this one has to
  // be threaded through explicitly.
  const nonce = (await headers()).get("x-nonce") ?? undefined

  return (
    <html
      lang={locale}
      dir={direction}
      suppressHydrationWarning
      className={`${fontSans.variable} ${fontMono.variable} font-sans antialiased`}
    >
      {/* Favicon */}
      <link rel="icon" type="image/png" href={config.site.favicon} />
      <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      <link rel="manifest" href="/manifest.webmanifest" />

      <body suppressHydrationWarning>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus:rounded focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow"
        >
          {t("skipToContent")}
        </a>
        <DirectionProvider dir={direction}>
          <ThemeProvider nonce={nonce}>
            <QueryProvider>
              <LocaleProvider locale={locale}>
                <TranslationProvider dictionaries={dictionaries}>
                  {children}
                  <LanguagePrompt />
                  <Toaster
                    richColors
                    position="top-right"
                    containerAriaLabel={tCommon("notifications")}
                  />
                </TranslationProvider>
              </LocaleProvider>
            </QueryProvider>
          </ThemeProvider>
        </DirectionProvider>
      </body>
    </html>
  )
}
