"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@sendcms/ui"

import { AlertTriangle } from "lucide-react"
import { useTranslation } from "@/components/dashboard/translation-provider"

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const router = useRouter()
  const { t } = useTranslation("navigation")

  useEffect(() => {
    // Log error to monitoring service
    console.error("Dashboard error:", error)
  }, [error])

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center p-6 text-center">
      <AlertTriangle
        className="mb-4 size-12 text-destructive"
        aria-hidden="true"
      />
      <h2 className="mb-2 text-lg font-semibold">{t("errorTitle")}</h2>
      <p className="mb-6 max-w-sm text-sm text-muted-foreground">
        {t("errorDescription")}
      </p>
      <div className="flex gap-3">
        <Button onClick={reset} variant="default">
          {t("errorTryAgain")}
        </Button>
        <Button onClick={() => router.push("/dashboard")} variant="outline">
          {t("errorGoToDashboard")}
        </Button>
      </div>
    </div>
  )
}
