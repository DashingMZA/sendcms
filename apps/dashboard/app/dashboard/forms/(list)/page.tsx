import Link from "next/link"
import { requireDashboardSession } from "@/lib/require-session"
import { listFormsPageForUser } from "@sendcms/forms"
import { FormListQuerySchema } from "@sendcms/forms/validators"

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
import { FormsTable } from "../forms-table"

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function FormsPage({ searchParams }: Props) {
  const session = await requireDashboardSession()
  const raw = await searchParams
  const flat: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") flat[key] = value
  }
  const parsed = FormListQuerySchema.safeParse(flat)
  // SRC-119: the list-page policy — an invalid filter falls back to
  // the schema defaults, never throws and never 500s (same policy as
  // the inbox page). A mistyped `?page=` shows page 1; an unknown
  // param is dropped here (the API route itself 422s it).
  const params = parsed.success ? parsed.data : FormListQuerySchema.parse({})
  const forms = await listFormsPageForUser(session.user.id, params)

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
          <FormsTable initialData={forms} params={params} />
        </TranslationProvider>
      </div>
    </div>
  )
}
