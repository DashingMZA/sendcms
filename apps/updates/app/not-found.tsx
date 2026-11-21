import type { Metadata } from "next"
import { NotFoundPage } from "@sendcms/ui"

export const metadata: Metadata = {
  title: "Page not found — SendCMS Changelog",
  description: "The page you're looking for doesn't exist or was moved.",
}

// Updates 404: back to the changelog.
export default function NotFound() {
  return (
    <NotFoundPage
      message="The page you're looking for doesn't exist or was moved. Head back to the changelog."
      links={[
        { href: "/changelog", label: "Back to changelog", primary: true },
      ]}
    />
  )
}
