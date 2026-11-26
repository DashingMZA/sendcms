import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { McpKeysListQuerySchema } from "@sendcms/mcp-admin/validators"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { PageHeader } from "@/components/admin/page-header"
import { McpKeysTable } from "@/components/admin/mcp-keys-table"

// Page <title> follows the page locale (I18N-204): the title
// is the same key the <h1> renders, so title == heading.
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "mcp")
  return {
    title: `${t("keysTitle")} — SendCMS Admin`,
    description: t("keysDescription"),
  }
}

// MCP keys (Phase 6). Filters + pagination come from the URL and
// are handed to the client table as its initial state; the server
// only authenticates and resolves the actor's role.
export default async function AdminMcpKeysPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const filters = McpKeysListQuerySchema.parse(await searchParams)

  const actorRole =
    session.user.platformRole === "PLATFORM_OWNER"
      ? "PLATFORM_OWNER"
      : (session.user.adminRole ?? "PLATFORM_USER")

  const locale = await getRequestLocale(session.user.id)
  const t = await getTranslator(locale, "mcp")

  return (
    <div>
      <PageHeader title={t("keysTitle")} description={t("keysDescription")} />
      <main id="main-content" className="flex flex-col gap-6 p-6">
        <McpKeysTable actorRole={actorRole} initialFilters={filters} />
      </main>
    </div>
  )
}
