import type { Metadata } from "next"
import { NotFoundPage } from "@sendcms/ui"

export const metadata: Metadata = {
  title: "Page not found — SendCMS Docs",
  description: "The page you're looking for doesn't exist or was moved.",
}

// Docs 404: back to the docs index.
export default function NotFound() {
  return (
    <NotFoundPage
      message="The docs page you're looking for doesn't exist or was moved. Head back to the docs index."
      links={[{ href: "/docs", label: "Back to docs", primary: true }]}
    />
  )
}
