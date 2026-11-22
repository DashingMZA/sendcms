import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { AiUsageListQuerySchema } from "@sendcms/ai-settings/validators"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { AiUsageTable } from "@/components/admin/ai-usage-table"

export const metadata: Metadata = {
  title: "AI usage — SendCMS Admin",
  description: "Every AI call, with BYOK and platform usage kept separate.",
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

  const locale = await getRequestLocale()
  const t = await getTranslator(locale, "ai")

  return (
    <main id="main-content" className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("usageTitle")}</h1>
        <p className="text-muted-foreground">{t("usageDescription")}</p>
      </div>
      <AiUsageTable actorRole={actorRole} initialFilters={filters} />
    </main>
  )
}
