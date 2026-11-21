import Link from "next/link"
import { Button } from "./button"

// Shared 404 page. Each app renders it from its own `not-found.tsx`
// with the links that make sense there (the apps live on different
// origins, so the links are app-relative). Plain Tailwind classes
// only — no app-specific type utilities, so it renders the same in
// every app.
export type NotFoundLink = {
  href: string
  label: string
  /** First link is the primary action; the rest are outline buttons. */
  primary?: boolean
}

export function NotFoundPage({
  title = "Page not found",
  message = "The page you're looking for doesn't exist or was moved.",
  links,
}: {
  title?: string
  message?: string
  links: NotFoundLink[]
}) {
  return (
    <main
      id="main-content"
      className="flex min-h-svh flex-col items-center justify-center px-4 py-16 text-center"
    >
      <p className="mb-2 text-7xl font-bold tracking-tight text-primary">404</p>
      <h1 className="mb-3 text-2xl font-bold tracking-tight">{title}</h1>
      <p className="mb-8 max-w-md leading-relaxed text-muted-foreground">
        {message}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        {links.map((link) => (
          <Button
            key={link.href}
            asChild
            variant={link.primary ? "default" : "outline"}
          >
            <Link href={link.href}>{link.label}</Link>
          </Button>
        ))}
      </div>
    </main>
  )
}
