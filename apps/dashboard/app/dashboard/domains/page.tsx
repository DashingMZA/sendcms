import Link from "next/link"
import { requireDashboardSession } from "@/lib/require-session"
import { listDomainsForUser } from "@sendcms/domains"

import { PageHeader } from "@/components/dashboard/page-header"
import { Button } from "@sendcms/ui"

import { RiAddLine } from "@remixicon/react"
import {
  DASHBOARD_DOMAINS_DOMAINS,
  getDictionaries,
  getRequestLocale,
  getTranslator,
} from "@/lib/i18n"
import { TranslationProvider } from "@/components/dashboard/translation-provider"
import { DomainsTable } from "./domains-table"

export default async function DomainsPage() {
  const session = await requireDashboardSession()
  const domains = await listDomainsForUser(session.user.id)

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

      <div className="p-4 sm:p-6">
        <TranslationProvider dictionaries={dictionaries}>
          <DomainsTable initialDomains={domains} />
        </TranslationProvider>
      </div>
    </div>
  )
}
