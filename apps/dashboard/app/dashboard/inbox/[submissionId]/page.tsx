import { notFound } from "next/navigation"
import { requireDashboardSession } from "@/lib/require-session"
import { getSubmissionForUser } from "@sendcms/inbox"
import { ApiError } from "@sendcms/api-client"

import { PageHeader } from "@/components/dashboard/page-header"
import { PageContent } from "@/components/dashboard/page-content"
import { SubmissionDetail } from "../submission-detail"
import {
  DASHBOARD_INBOX_DOMAINS,
  getDictionaries,
  getRequestLocale,
  getTranslator,
} from "@/lib/i18n"
import { TranslationProvider } from "@/components/dashboard/translation-provider"

type Params = { params: Promise<{ submissionId: string }> }

export default async function SubmissionDetailPage({ params }: Params) {
  const { submissionId } = await params
  const session = await requireDashboardSession()
  let submission
  try {
    submission = await getSubmissionForUser(session.user.id, submissionId)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound()
    throw err
  }

  const locale = await getRequestLocale(session.user.id)
  const dictionaries = await getDictionaries(locale, DASHBOARD_INBOX_DOMAINS)
  const t = await getTranslator(locale, "inbox")

  return (
    <div>
      <PageHeader
        title={t("detailTitle")}
        description={t("submissionDescription", {
          form: submission.form.name,
          origin: submission.originDomain,
        })}
      />
      <PageContent>
        <TranslationProvider dictionaries={dictionaries}>
          <SubmissionDetail initialData={submission} />
        </TranslationProvider>
      </PageContent>
    </div>
  )
}
