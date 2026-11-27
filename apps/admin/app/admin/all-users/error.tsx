"use client"

import { useEffect } from "react"
import Link from "next/link"
import { Button } from "@sendcms/ui"
import { createLogger } from "@sendcms/observability"
import { useTranslation } from "@/components/admin/translation-provider"

// All-users error boundary (Phase A, plan §3.2 — Wave 10 SRC-111
// pattern, modelled on the admin section error boundary): generic
// message, never the error's own message or stack (SEC-107), and logs
// through the structured logger instead of console. The `error` prop
// is declared in the props type (Next.js requires it) and deliberately
// not destructured.
const logger = createLogger("all-users-error")

export default function AllUsersError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const { t } = useTranslation("navigation")

  useEffect(() => {
    logger.error("All-users error:", { error })
  }, [error])

  return (
    <div
      tabIndex={-1}
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
    </div>
  )
}
