import { requireDashboardSession } from "@/lib/require-session"
import { PageHeader } from "@/components/dashboard/page-header"
import { listFormsForUser } from "@sendcms/forms"
import { listEmailJobsForUser } from "@sendcms/notifications"
import { EmailJobListQuerySchema } from "@sendcms/notifications/validators"
import {
  DASHBOARD_NOTIFICATIONS_DOMAINS,
  getDictionaries,
  getRequestLocale,
  getTranslator,
} from "@/lib/i18n"
import { TranslationProvider } from "@/components/dashboard/translation-provider"

import { EmailJobsTable } from "./email-jobs-table"

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function NotificationsPage({ searchParams }: Props) {
  const session = await requireDashboardSession()
  const userId = session.user.id

  const raw = await searchParams
  const flat: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") flat[key] = value
  }
  const parsed = EmailJobListQuerySchema.safeParse(flat)
  const params = parsed.success ? parsed.data : { page: 1 }

  const [list, forms] = await Promise.all([
    listEmailJobsForUser(userId, params),
    listFormsForUser(userId),
  ])

  const locale = await getRequestLocale(userId)
  const dictionaries = await getDictionaries(
    locale,
    DASHBOARD_NOTIFICATIONS_DOMAINS
  )
  const t = await getTranslator(locale, "notifications")

  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />
      <div className="p-4 sm:p-6">
        <TranslationProvider dictionaries={dictionaries}>
          <EmailJobsTable
            initialData={list}
            params={params}
            forms={forms.map((form) => ({ id: form.id, name: form.name }))}
          />
        </TranslationProvider>
      </div>
    </div>
  )
}
