"use client"

import { useEffect } from "react"
import Link from "next/link"
import { Button } from "@sendcms/ui"
import { createLogger } from "@sendcms/observability"
import { useTranslation } from "@/components/admin/translation-provider"

// Admin error boundary for /admin/* (SRC-111): mirrors the root
// app/error.tsx (SEC-107 — generic message, never the error's own
// message or stack) and logs through the structured logger instead
// of console. The `error` prop is declared in the props type (Next.js
// requires it) and deliberately not destructured.
const logger = createLogger("admin-error")

export default function AdminSectionError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const { t } = useTranslation("navigation")

  useEffect(() => {
    logger.error("Admin error:", { error })
  }, [error])

  return (
    <main
      id="main-content"
      className="flex flex-col items-center justify-center px-4 py-16 text-center"
    >
      <h1 className="mb-3 text-2xl font-bold tracking-tight">
        {t("errorTitle")}
      </h1>
      <p className="mb-8 max-w-md leading-relaxed text-muted-foreground">
        {t("errorDescription")}
      </p>
      <div className="flex gap-3">
        <Button onClick={reset}>{t("errorTryAgain")}</Button>
        <Button asChild variant="outline">
          <Link href="/admin">{t("errorGoToDashboard")}</Link>
        </Button>
      </div>
    </main>
  )
}
