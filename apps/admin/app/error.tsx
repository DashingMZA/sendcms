"use client"

import Link from "next/link"
import { Button } from "@sendcms/ui"

// Admin error boundary (Phase 16, Wave 2 — SEC-107): when an admin
// page throws during render, Next.js renders this instead of its
// default error payload, so the auth error and the server stack
// (with absolute filesystem paths) never reach the browser. The
// message is generic on purpose — never the error's own message or
// its stack. The `error` prop is declared in the props type (Next.js
// requires it) and deliberately not destructured.
export default function AdminError({
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <main
      id="main-content"
      className="flex flex-col items-center justify-center px-4 py-16 text-center"
    >
      <h1 className="mb-3 text-2xl font-bold tracking-tight">
        Something went wrong
      </h1>
      <p className="mb-8 max-w-md leading-relaxed text-muted-foreground">
        This admin page could not be loaded. Try again, or go back to the admin
        dashboard.
      </p>
      <div className="flex gap-3">
        <Button onClick={reset}>Try again</Button>
        <Button asChild variant="outline">
          <Link href="/admin">Back to the dashboard</Link>
        </Button>
      </div>
    </main>
  )
}
