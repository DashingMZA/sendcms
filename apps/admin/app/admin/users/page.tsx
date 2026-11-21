import type { Metadata } from "next"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { PlannedSection } from "@/components/admin/planned-section"

export const metadata: Metadata = {
  title: "Users — SendCMS Admin",
  description: "Manage platform users.",
}

// User management lands in Phase 3.
export default async function AdminUsersPage() {
  const locale = await getRequestLocale()
  const t = await getTranslator(locale, "dashboard")
  const tNav = await getTranslator(locale, "navigation")
  return (
    <PlannedSection
      title={tNav("users")}
      description={t("comingSoonDescription")}
      phaseLabel={t("phase", { number: "3" })}
    />
  )
}
