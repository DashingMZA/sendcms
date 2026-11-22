import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { McpKeysTable } from "@/components/admin/mcp-keys-table"

export const metadata: Metadata = {
  title: "MCP keys — SendCMS Admin",
  description: "Every MCP API key, its owner, and its recent calls.",
}

// MCP keys (Phase 6). The server only authenticates and resolves the
// actor's role; the client table reads the keys through the api app.
export default async function AdminMcpKeysPage() {
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
        <h1 className="text-2xl font-bold tracking-tight">{t("keysTitle")}</h1>
        <p className="text-muted-foreground">{t("keysDescription")}</p>
      </div>
      <McpKeysTable actorRole={actorRole} />
    </main>
  )
}
