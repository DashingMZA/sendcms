import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import config from "@/config/config.json"
import "./globals.css"
import { ThemeProvider } from "@sendcms/ui"
import { Toaster } from "@sendcms/ui"

export const metadata: Metadata = {
  title: "SendCMS - A Contact-Form Backend for Static and Modern Websites",
  description:
    "SendCMS is a contact-form backend for static and modern sites built with Astro, Hugo, or Next.js. Add one script tag and every form submission lands in a dashboard inbox.",
}

const fontSans = Geist({
  subsets: ["latin"],
  variable: "--font-sans",
})

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
})

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${fontSans.variable} ${fontMono.variable} font-sans antialiased`}
    >
      {/* Meta Informations */}
      {/* Favicon */}
      <link rel="icon" type="image/png" href={config.site.favicon} />

      <body suppressHydrationWarning>
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:shadow"
        >
          Skip to main content
        </a>
        <ThemeProvider>
          {children}
          <Toaster richColors position="top-right" />
        </ThemeProvider>
      </body>
    </html>
  )
}
