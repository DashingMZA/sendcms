import { requireDashboardSession } from "@/lib/require-session"
import { PageHeader } from "@/components/dashboard/page-header"
import {
  DASHBOARD_FORMS_DOMAINS,
  getDictionaries,
  getRequestLocale,
  getTranslator,
} from "@/lib/i18n"
import { TranslationProvider } from "@/components/dashboard/translation-provider"
import { NewFormForm } from "./new-form-form"

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

      <div className="p-4 sm:p-6">
        <TranslationProvider dictionaries={dictionaries}>
          <NewFormForm />
        </TranslationProvider>
      </div>
    </div>
  )
}
