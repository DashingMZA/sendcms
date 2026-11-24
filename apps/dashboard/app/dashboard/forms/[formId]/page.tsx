import { notFound } from "next/navigation"
import { requireDashboardSession } from "@/lib/require-session"
import { getFormForUser } from "@sendcms/forms"
import { ApiError } from "@sendcms/api-client"

import { PageHeader } from "@/components/dashboard/page-header"
import {
  DASHBOARD_FORMS_DOMAINS,
  getDictionaries,
  getRequestLocale,
  getTranslator,
} from "@/lib/i18n"
import { TranslationProvider } from "@/components/dashboard/translation-provider"
import { FormDetail } from "./form-detail"

type Params = { params: Promise<{ formId: string }> }

export default async function FormDetailPage({ params }: Params) {
  const { formId } = await params
  const session = await requireDashboardSession()
  let form
  try {
    form = await getFormForUser(session.user.id, formId)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound()
    throw err
  }

  const locale = await getRequestLocale(session.user.id)
  const dictionaries = await getDictionaries(locale, DASHBOARD_FORMS_DOMAINS)
  const t = await getTranslator(locale, "forms")

  return (
    <div>
      <PageHeader title={form.name} description={t("detailDescription")} />

      <div className="p-4 sm:p-6">
        <TranslationProvider dictionaries={dictionaries}>
          <FormDetail
            initialForm={form}
            appUrl={process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}
          />
        </TranslationProvider>
      </div>
    </div>
  )
}
