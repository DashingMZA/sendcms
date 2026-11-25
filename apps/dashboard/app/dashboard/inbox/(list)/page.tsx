import { requireDashboardSession } from "@/lib/require-session"
import { PageHeader } from "@/components/dashboard/page-header"
import { listDomainsForUser } from "@sendcms/domains"
import { listFormsForUser } from "@sendcms/forms"
import { listSubmissionsForUser } from "@sendcms/inbox"
import { InboxListQuerySchema } from "@sendcms/inbox/validators"
import {
  DASHBOARD_INBOX_DOMAINS,
  getDictionaries,
  getRequestLocale,
  getTranslator,
} from "@/lib/i18n"
import { TranslationProvider } from "@/components/dashboard/translation-provider"

import { InboxTable } from "../inbox-table"

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function InboxPage({ searchParams }: Props) {
  const session = await requireDashboardSession()
  const userId = session.user.id

  const raw = await searchParams
  const flat: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") flat[key] = value
  }
  const parsed = InboxListQuerySchema.safeParse(flat)
  // SRC-119: the list-page policy — an invalid filter falls back to
  // the schema defaults, never throws and never 500s (same policy as
  // the admin users page). A mistyped `?tab=` shows "all"; a bad
  // `?from=` date drops the date filter.
  const params = parsed.success ? parsed.data : InboxListQuerySchema.parse({})

  const [list, forms, domains] = await Promise.all([
    listSubmissionsForUser(userId, params),
    listFormsForUser(userId),
    listDomainsForUser(userId),
  ])

  const locale = await getRequestLocale(userId)
  const dictionaries = await getDictionaries(locale, DASHBOARD_INBOX_DOMAINS)
  const t = await getTranslator(locale, "inbox")

  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />
      <div className="p-4 sm:p-6">
        <TranslationProvider dictionaries={dictionaries}>
          <InboxTable
            initialData={list}
            params={params}
            forms={forms.map((form) => ({ id: form.id, name: form.name }))}
            domains={domains.map((domain) => ({ domain: domain.domain }))}
          />
        </TranslationProvider>
      </div>
    </div>
  )
}
