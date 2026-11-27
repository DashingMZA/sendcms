import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { PageHeader } from "@/components/admin/page-header"
import { McpOverview } from "@/components/admin/mcp-overview"

// Page <title> follows the page locale (I18N-204): the title
// is the same key the <h1> renders, so title == heading.
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "mcp")
  return {
    title: `${t("overviewTitle")} — SendCMS Admin`,
    description: t("overviewDescription"),
  }
}

// MCP overview (Phase 6). The server only authenticates and resolves
// the actor's role; the client component reads the kill-switch state
// and the usage summary through the api app.
export default async function AdminMcpPage() {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const actorRole =
    session.user.platformRole === "PLATFORM_OWNER"
      ? "PLATFORM_OWNER"
      : (session.user.adminRole ?? "PLATFORM_USER")

  const locale = await getRequestLocale(session.user.id)
  const t = await getTranslator(locale, "mcp")

  return (
    <div>
      <PageHeader
        title={t("overviewTitle")}
        description={t("overviewDescription")}
      />
      <div tabIndex={-1} className="flex flex-col gap-6 p-6">
        <McpOverview actorRole={actorRole} />
      </div>
    </div>
  )
}
