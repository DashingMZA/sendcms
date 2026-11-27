import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { notFound } from "next/navigation"
import { requireDashboardSession } from "@/lib/require-session"
import { getDomainForUser } from "@sendcms/domains"
import { ApiError } from "@sendcms/api-client"

import { PageHeader } from "@/components/dashboard/page-header"
import { PageContent } from "@/components/dashboard/page-content"
import {
  DASHBOARD_DOMAINS_DOMAINS,
  getDictionaries,
  getRequestLocale,
  getTranslator,
} from "@/lib/i18n"
import { TranslationProvider } from "@/components/dashboard/translation-provider"
import { DomainDetail } from "./domain-detail"

// SRC-113: the tab title is the domain itself (the same string the
// <h1> renders); a missing/wrong-owner domain falls back to the
// generic title and the page itself still 404s.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ domainId: string }>
}): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "domains")
  const { domainId } = await params
  try {
    const domain = await getDomainForUser(session?.user?.id ?? "", domainId)
    return { title: domain.domain, description: t("detailDescription") }
  } catch {
    return { title: t("title"), description: t("detailDescription") }
  }
}

export default async function DomainDetailPage({
  params,
}: {
  params: Promise<{ domainId: string }>
}) {
  const session = await requireDashboardSession()
  const { domainId } = await params
  let domain: Awaited<ReturnType<typeof getDomainForUser>> | null = null
  try {
    domain = await getDomainForUser(session.user.id, domainId)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound()
    throw err
  }
  if (!domain) notFound()

  const locale = await getRequestLocale(session.user.id)
  const dictionaries = await getDictionaries(locale, DASHBOARD_DOMAINS_DOMAINS)
  const t = await getTranslator(locale, "domains")

  return (
    <div>
      <PageHeader title={domain.domain} description={t("detailDescription")} />

      <PageContent>
        <TranslationProvider dictionaries={dictionaries}>
          <DomainDetail initialDomain={domain} />
        </TranslationProvider>
      </PageContent>
    </div>
  )
}
