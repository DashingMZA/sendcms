import Link from "next/link"
import { requireDashboardSession } from "@/lib/require-session"
import { listDomainsPageForUser } from "@sendcms/domains"
import { DomainListQuerySchema } from "@sendcms/domains/validators"

import { PageHeader } from "@/components/dashboard/page-header"
import { PageContent } from "@/components/dashboard/page-content"
import { Button } from "@sendcms/ui"

import { RiAddLine } from "@remixicon/react"
import {
  DASHBOARD_DOMAINS_DOMAINS,
  getDictionaries,
  getRequestLocale,
  getTranslator,
} from "@/lib/i18n"
import { TranslationProvider } from "@/components/dashboard/translation-provider"
import { DomainsTable } from "../domains-table"

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function DomainsPage({ searchParams }: Props) {
  const session = await requireDashboardSession()
  const raw = await searchParams
  const flat: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") flat[key] = value
  }
  const parsed = DomainListQuerySchema.safeParse(flat)
  // SRC-119: the list-page policy — an invalid filter falls back to
  // the schema defaults, never throws and never 500s (same policy as
  // the inbox page). A mistyped `?page=` shows page 1; an unknown
  // param is dropped here (the API route itself 422s it).
  const params = parsed.success ? parsed.data : DomainListQuerySchema.parse({})
  const domains = await listDomainsPageForUser(session.user.id, params)

  const locale = await getRequestLocale(session.user.id)
  const dictionaries = await getDictionaries(locale, DASHBOARD_DOMAINS_DOMAINS)
  const t = await getTranslator(locale, "domains")

  return (
    <div>
      <PageHeader
        title={t("title")}
        description={t("description")}
        action={
          <Button asChild size="sm">
            <Link href="/dashboard/domains/new">
              <RiAddLine className="size-4" aria-hidden="true" />
              {t("addDomain")}
            </Link>
          </Button>
        }
      />

      <PageContent>
        <TranslationProvider dictionaries={dictionaries}>
          <DomainsTable initialData={domains} params={params} />
        </TranslationProvider>
      </PageContent>
    </div>
  )
}
