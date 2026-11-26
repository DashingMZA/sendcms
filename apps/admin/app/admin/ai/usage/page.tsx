import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { AiUsageListQuerySchema } from "@sendcms/ai-settings/validators"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { PageHeader } from "@/components/admin/page-header"
import { AiUsageTable } from "@/components/admin/ai-usage-table"

// Page <title> follows the page locale (I18N-204): the title
// is the same key the <h1> renders, so title == heading.
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "ai")
  return {
    title: `${t("usageTitle")} — SendCMS Admin`,
    description: t("usageDescription"),
  }
}

// AI usage (Phase 5). Filters come from the URL (a userId prefilter
// arrives from the user detail's AI tab); the client table owns the
// filters and pagination from there. The server only authenticates
// and resolves the actor's role.
export default async function AdminAiUsagePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const filters = AiUsageListQuerySchema.parse(await searchParams)

  const actorRole =
    session.user.platformRole === "PLATFORM_OWNER"
      ? "PLATFORM_OWNER"
      : (session.user.adminRole ?? "PLATFORM_USER")

  const locale = await getRequestLocale(session.user.id)
  const t = await getTranslator(locale, "ai")

  return (
    <div>
      <PageHeader title={t("usageTitle")} description={t("usageDescription")} />
      <main id="main-content" className="flex flex-col gap-6 p-6">
        <AiUsageTable actorRole={actorRole} initialFilters={filters} />
      </main>
    </div>
  )
}
