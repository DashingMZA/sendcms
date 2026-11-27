import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { requireDashboardSession } from "@/lib/require-session"
import { PageHeader } from "@/components/dashboard/page-header"
import { PageContent } from "@/components/dashboard/page-content"
import {
  DASHBOARD_FORMS_DOMAINS,
  getDictionaries,
  getRequestLocale,
  getTranslator,
} from "@/lib/i18n"
import { TranslationProvider } from "@/components/dashboard/translation-provider"
import { NewFormForm } from "./new-form-form"

// Page <title> follows the page locale (I18N-204): the title is the same
// key the <h1> renders, so title == heading. (SRC-113: every dashboard
// page exports metadata; the layout template appends "— SendCMS Dashboard".)
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "forms")
  return {
    title: t("newTitle"),
    description: t("newDescription"),
  }
}

export default async function NewFormPage() {
  const session = await requireDashboardSession()
  // I18N-311: pass the session user id so the stored DB preference
  // resolves here like on every sibling page — without it this page
  // rendered English while /dashboard/forms on either side rendered
  // Urdu for a stored-`ur` user with no cookie.
  const locale = await getRequestLocale(session.user.id)
  const dictionaries = await getDictionaries(locale, DASHBOARD_FORMS_DOMAINS)
  const t = await getTranslator(locale, "forms")

  return (
    <div>
      <PageHeader title={t("newTitle")} description={t("newDescription")} />

      <PageContent>
        <TranslationProvider dictionaries={dictionaries}>
          <NewFormForm />
        </TranslationProvider>
      </PageContent>
    </div>
  )
}
