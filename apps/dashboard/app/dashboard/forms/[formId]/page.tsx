import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { notFound } from "next/navigation"
import { requireDashboardSession } from "@/lib/require-session"
import { getFormForUser } from "@sendcms/forms"
import { ApiError } from "@sendcms/api-client"

import { PageHeader } from "@/components/dashboard/page-header"
import { PageContent } from "@/components/dashboard/page-content"
import {
  DASHBOARD_FORMS_DOMAINS,
  getDictionaries,
  getRequestLocale,
  getTranslator,
} from "@/lib/i18n"
import { TranslationProvider } from "@/components/dashboard/translation-provider"
import { FormDetail } from "./form-detail"

type Params = { params: Promise<{ formId: string }> }

// SRC-113: the tab title is the form name (the same string the <h1>
// renders); a missing/wrong-owner form falls back to the generic
// title and the page itself still 404s.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ formId: string }>
}): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "forms")
  const { formId } = await params
  try {
    const form = await getFormForUser(session?.user?.id ?? "", formId)
    return { title: form.name, description: t("detailDescription") }
  } catch {
    return { title: t("title"), description: t("detailDescription") }
  }
}

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

      <PageContent>
        <TranslationProvider dictionaries={dictionaries}>
          <FormDetail
            initialForm={form}
            appUrl={process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"}
            turnstileSiteKey={
              process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? null
            }
          />
        </TranslationProvider>
      </PageContent>
    </div>
  )
}
