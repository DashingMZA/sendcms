import type { Metadata } from "next"
import { NotFoundPage } from "@sendcms/ui"

export const metadata: Metadata = {
  title: "Page not found — SendCMS Dashboard",
  description: "The page you're looking for doesn't exist or was moved.",
  // Error page — never indexed (Phase 16, PRF-034).
  robots: { index: false, follow: false },
}

// Dashboard 404: back to the overview, or to sign-in.
export default function NotFound() {
  return (
    <NotFoundPage
      message="The page you're looking for doesn't exist or was moved. Head back to your dashboard."
      links={[
        { href: "/dashboard", label: "Back to dashboard", primary: true },
        { href: "/sign-in", label: "Sign in" },
      ]}
    />
  )
}
