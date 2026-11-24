import type { Metadata } from "next"
import { headers } from "next/headers"
import { Geist, Geist_Mono } from "next/font/google"
import config from "@/config/config.json"
import "./globals.css"
import { ThemeProvider, Toaster } from "@sendcms/ui"
import {
  SHELL_TRANSLATION_DOMAINS,
  getDictionaries,
  getLocaleDirection,
  getRequestLocale,
  getTranslator,
} from "@/lib/i18n"
import { TranslationProvider } from "@/components/admin/translation-provider"
import { QueryProvider } from "@/components/admin/query-provider"
import { LanguagePrompt } from "@/components/admin/language-prompt"

export const metadata: Metadata = {
  title: "SendCMS Admin",
  description:
    "SendCMS Admin Control Plane — manage users, plans, subscriptions, AI and MCP access, and platform operations.",
  // Authenticated app — nothing here is for crawlers (Phase 16,
  // PRF-034). Defence in depth alongside robots.ts and the
  // `X-Robots-Tag` header in next.config.mjs.
  robots: { index: false, follow: false },
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
  const locale = await getRequestLocale()
  const direction = getLocaleDirection(locale)
  const dictionaries = await getDictionaries(locale, SHELL_TRANSLATION_DOMAINS)
  const t = await getTranslator(locale, "dashboard")
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

      <body suppressHydrationWarning>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus:rounded focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow"
        >
          {t("skipToContent")}
        </a>
        <ThemeProvider nonce={nonce}>
          <QueryProvider>
            <TranslationProvider dictionaries={dictionaries}>
              {children}
              <LanguagePrompt />
              <Toaster richColors position="top-right" />
            </TranslationProvider>
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
