import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { format } from "date-fns"
import { requireDashboardSession } from "@/lib/require-session"
import { PageHeader } from "@/components/dashboard/page-header"
import { PageContent } from "@/components/dashboard/page-content"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@sendcms/ui"
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

// Page <title> follows the page locale (I18N-204): the title is the same
// key the <h1> renders, so title == heading. (SRC-113: every dashboard
// page exports metadata; the layout template appends "— SendCMS Dashboard".)
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "notifications")
  return {
    title: t("title"),
    description: t("description"),
  }
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
      <PageContent>
        {/* EML-093/096: the digest summary — read-only here (the
            toggle + frequency live on each form's detail page), one
            consistent shape with that page's digest section. */}
        <Card>
          <CardHeader>
            <CardTitle>{t("digestSectionTitle")}</CardTitle>
            <CardDescription>{t("digestSectionDescription")}</CardDescription>
          </CardHeader>
          <CardContent>
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
          </CardContent>
        </Card>
        <TranslationProvider dictionaries={dictionaries}>
          <EmailJobsTable
            initialData={list}
            params={params}
            forms={forms.map((form) => ({ id: form.id, name: form.name }))}
          />
        </TranslationProvider>
      </PageContent>
    </div>
  )
}
