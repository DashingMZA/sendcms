import type { Metadata } from "next"
import { ContactUsDemoForm } from "./demo-form"
import { pageOpenGraph } from "@/lib/utils"

export const metadata: Metadata = {
  // PRF-035 (Wave 11, Stream C): the demo finally has its own title —
  // the page used to be a bare "use client" component, so it inherited
  // the homepage title verbatim. The form itself moved unchanged into
  // ./demo-form.tsx so this server page can export metadata.
  title: "Live demo — SendCMS",
  description:
    "Try the real SendCMS Contact us form two ways — the JavaScript SDK with one script tag, or a plain REST API fetch — and watch it land in the inbox.",
  // PRF-031/032 (Wave 11, Stream C): self-canonical + og:url.
  alternates: { canonical: "/demo/contact-us" },
  openGraph: pageOpenGraph("/demo/contact-us"),
}

export default function ContactUsDemoPage() {
  return <ContactUsDemoForm />
}
