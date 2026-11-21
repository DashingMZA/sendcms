import type { Metadata } from "next"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { PlannedSection } from "@/components/admin/planned-section"

export const metadata: Metadata = {
  title: "Settings — SendCMS Admin",
  description: "Platform settings and configuration.",
}

// Platform settings land in Phase 7.
export default async function AdminSettingsPage() {
  const locale = await getRequestLocale()
  const t = await getTranslator(locale, "dashboard")
  const tNav = await getTranslator(locale, "navigation")
  return (
    <PlannedSection
      title={tNav("settings")}
      description={t("comingSoonDescription")}
      phaseLabel={t("phase", { number: "7" })}
    />
  )
}
