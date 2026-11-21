import type { Metadata } from "next"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { PlannedSection } from "@/components/admin/planned-section"

export const metadata: Metadata = {
  title: "Activity — SendCMS Admin",
  description: "Audit log, feature flags, health, and announcements.",
}

// Platform operations land in Phase 7.
export default async function AdminActivityPage() {
  const locale = await getRequestLocale()
  const t = await getTranslator(locale, "dashboard")
  const tNav = await getTranslator(locale, "navigation")
  return (
    <PlannedSection
      title={tNav("activity")}
      description={t("comingSoonDescription")}
      phaseLabel={t("phase", { number: "7" })}
    />
  )
}
