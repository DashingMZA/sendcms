import { redirect } from "next/navigation"
import { requireDashboardSession } from "@/lib/require-session"
import { PageHeader } from "@/components/dashboard/page-header"
import { listDomainsForUser } from "@sendcms/domains"
import { listFormsForUser } from "@sendcms/forms"
import { listSubmissionsForUser } from "@sendcms/inbox"
import { resolveInboxListParams } from "@sendcms/inbox/validators"
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
  const raw = await searchParams
  // SRC-124: an invalid filter redirects to the canonical URL with
  // corrected params instead of silently showing the corrected list
  // (the old safeParse fallback: a mistyped `?tab=` showed "all"
  // with no signal). The resolver's canonical query parses back to
  // exactly these params, so the redirect cannot loop. This runs
  // BEFORE the session lookup on purpose: the decision is pure and
  // needs no I/O, so the redirect is thrown before the page
  // suspends on the database — a redirect thrown after the shell
  // has started streaming only reaches the browser as a flight
  // instruction, not a 307. (An unauthenticated request still
  // lands on sign-in afterwards, with the canonical URL as its
  // callbackURL, via the dashboard proxy.)
  const { params, needsRedirect, canonicalSearch } = resolveInboxListParams(raw)
  if (needsRedirect) {
    redirect(`/dashboard/inbox${canonicalSearch ? `?${canonicalSearch}` : ""}`)
  }

  const session = await requireDashboardSession()
  const userId = session.user.id

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
