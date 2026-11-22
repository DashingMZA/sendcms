import type { Metadata } from "next"
import Link from "next/link"
import config from "@/config/config.json"
import { Logo } from "@sendcms/ui"
import ContactForm from "./contact-form"

export const metadata: Metadata = {
  title: "Contact us",
  description:
    "Questions, feedback, or a partnership idea? Send us a message — it lands straight in our inbox.",
}

export default function ContactPage() {
  return (
    <div className="flex min-h-svh flex-col">
      {/* Minimal site header — the marketing nav lives in the homepage
          component, so this page carries its own logo link home. */}
      <header className="border-b">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4">
          <Link href="/" className="flex items-center font-semibold">
            <Logo brand={config.site} />
          </Link>
          <Link
            href="/"
            className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            ← Back to SendCMS
          </Link>
        </div>
      </header>

      <main
        id="main-content"
        className="mx-auto w-full max-w-2xl flex-1 px-4 py-12"
      >
        <h1 className="mb-3 text-step-4 font-bold tracking-tight">
          Contact us
        </h1>
        <p className="mb-8 leading-relaxed text-muted-foreground">
          Questions, feedback, or a partnership idea? Send a message — it lands
          straight in our inbox and we&apos;ll get back to you.
        </p>

        <ContactForm />

        <p className="mt-8 text-center text-sm text-muted-foreground">
          Prefer the live demo instead?{" "}
          <Link
            href="/demo/contact-us"
            className="underline underline-offset-4 hover:text-foreground"
          >
            Try the demo form
          </Link>
        </p>
      </main>
    </div>
  )
}
