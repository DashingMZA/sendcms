import type { Metadata } from "next"
import { NotFoundPage } from "@sendcms/ui"

export const metadata: Metadata = {
  title: "Page not found — SendCMS",
  description: "The page you're looking for doesn't exist or was moved.",
}

// Marketing 404: back to the homepage, or try the live form demo.
export default function NotFound() {
  return (
    <NotFoundPage
      message="The page you're looking for doesn't exist or was moved. Head back home, or try the live contact-form demo."
      links={[
        { href: "/", label: "Back to home", primary: true },
        { href: "/demo/contact-us", label: "Try the live demo" },
      ]}
    />
  )
}
