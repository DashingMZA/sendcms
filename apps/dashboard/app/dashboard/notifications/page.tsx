import { format } from "date-fns"
import { requireDashboardSession } from "@/lib/require-session"
import { PageHeader } from "@/components/dashboard/page-header"
import { listFormsForUser } from "@sendcms/forms"
import {
  listDigestStatesForUser,
  listEmailJobsForUser,
} from "@sendcms/notifications"
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

  const [list, forms, digestStates] = await Promise.all([
    listEmailJobsForUser(userId, params),
    listFormsForUser(userId),
    listDigestStatesForUser(userId),
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
      <div className="flex flex-col gap-6 p-4 sm:p-6">
        {/* EML-093/096: the digest summary — read-only here (the
            toggle + frequency live on each form's detail page), one
            consistent shape with that page's digest section. */}
        <section className="rounded-lg border p-4 sm:p-6">
          <h2 className="text-base font-semibold">{t("digestSectionTitle")}</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            {t("digestSectionDescription")}
          </p>
          {digestStates.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("digestNoForms")}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {digestStates.map((state) => (
                <li
                  key={state.formId}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-4 py-3 text-sm"
                >
                  <span className="font-medium">{state.formName}</span>
                  <span className="text-muted-foreground">
                    {state.digestEnabled ? t("digestOn") : t("digestOff")}
                  </span>
                  <span className="text-muted-foreground">
                    {t("digestLast")}{" "}
                    {state.lastDigestAt
                      ? format(new Date(state.lastDigestAt), "PPpp")
                      : t("digestNever")}
                    {" · "}
                    {t("digestNext")}{" "}
                    {state.nextDigestAt
                      ? format(new Date(state.nextDigestAt), "PPpp")
                      : t("digestNextPending")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
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
