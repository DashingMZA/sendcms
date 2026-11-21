import type { Metadata } from "next"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { PlannedSection } from "@/components/admin/planned-section"

export const metadata: Metadata = {
  title: "Plans — SendCMS Admin",
  description: "Manage plans, versions, and subscriptions.",
}

// Plans + versioned entitlements land in Phase 4.
export default async function AdminPlansPage() {
  const locale = await getRequestLocale()
  const t = await getTranslator(locale, "dashboard")
  const tNav = await getTranslator(locale, "navigation")
  return (
    <PlannedSection
      title={tNav("plans")}
      description={t("comingSoonDescription")}
      phaseLabel={t("phase", { number: "4" })}
    />
  )
}
