import Link from "next/link"
import { requireDashboardSession } from "@/lib/require-session"
import { listFormsForUser } from "@sendcms/forms"

import { PageHeader } from "@/components/dashboard/page-header"
import { Button } from "@sendcms/ui"

import { RiAddLine } from "@remixicon/react"
import {
  DASHBOARD_FORMS_DOMAINS,
  getDictionaries,
  getRequestLocale,
  getTranslator,
} from "@/lib/i18n"
import { TranslationProvider } from "@/components/dashboard/translation-provider"
import { FormsTable } from "./forms-table"

export default async function FormsPage() {
  const session = await requireDashboardSession()
  const forms = await listFormsForUser(session.user.id)

  const locale = await getRequestLocale(session.user.id)
  const dictionaries = await getDictionaries(locale, DASHBOARD_FORMS_DOMAINS)
  const t = await getTranslator(locale, "forms")

  return (
    <div>
      <PageHeader
        title={t("title")}
        description={t("description")}
        action={
          <Button asChild size="sm">
            <Link href="/dashboard/forms/new">
              <RiAddLine className="size-4" aria-hidden="true" />
              {t("newForm")}
            </Link>
          </Button>
        }
      />

      <div className="p-4 sm:p-6">
        <TranslationProvider dictionaries={dictionaries}>
          <FormsTable initialForms={forms} />
        </TranslationProvider>
      </div>
    </div>
  )
}
