import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { McpOverview } from "@/components/admin/mcp-overview"

export const metadata: Metadata = {
  title: "MCP — SendCMS Admin",
  description: "Manage MCP access, tools, and rate limits.",
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

  const locale = await getRequestLocale()
  const t = await getTranslator(locale, "mcp")

  return (
    <main id="main-content" className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {t("overviewTitle")}
        </h1>
        <p className="text-muted-foreground">{t("overviewDescription")}</p>
      </div>
      <McpOverview actorRole={actorRole} />
    </main>
  )
}
