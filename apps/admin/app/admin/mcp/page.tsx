import type { Metadata } from "next"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { PlannedSection } from "@/components/admin/planned-section"

export const metadata: Metadata = {
  title: "MCP — SendCMS Admin",
  description: "Manage MCP access, tools, and rate limits.",
}

// MCP controls land in Phase 6.
export default async function AdminMcpPage() {
  const locale = await getRequestLocale()
  const t = await getTranslator(locale, "dashboard")
  const tNav = await getTranslator(locale, "navigation")
  return (
    <PlannedSection
      title={tNav("mcp")}
      description={t("comingSoonDescription")}
      phaseLabel={t("phase", { number: "6" })}
    />
  )
}
