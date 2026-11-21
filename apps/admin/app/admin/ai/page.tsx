import type { Metadata } from "next"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { PlannedSection } from "@/components/admin/planned-section"

export const metadata: Metadata = {
  title: "AI — SendCMS Admin",
  description: "Manage AI providers, BYOK, and platform AI controls.",
}

// AI provider + BYOK controls land in Phase 5.
export default async function AdminAiPage() {
  const locale = await getRequestLocale()
  const t = await getTranslator(locale, "dashboard")
  const tNav = await getTranslator(locale, "navigation")
  return (
    <PlannedSection
      title={tNav("ai")}
      description={t("comingSoonDescription")}
      phaseLabel={t("phase", { number: "5" })}
    />
  )
}
