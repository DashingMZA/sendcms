import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { PageHeader } from "@/components/dashboard/page-header"
import {
  DASHBOARD_AI_DOMAINS,
  getDictionaries,
  getRequestLocale,
  getTranslator,
} from "@/lib/i18n"
import { TranslationProvider } from "@/components/dashboard/translation-provider"
import { AiManager } from "./ai-manager"

// The customer's AI page (Phase 5 — BYOK). The server only loads
// the translation dictionaries for the request locale; the keys and
// billing mode are read client-side through the api app, so the
// platform-key flag and the saved keys always come from the live
// service. Browser-only keys never reach this server at all.
export default async function AiPage() {
  const session = await auth()
  if (!session?.user) redirect("/sign-in")

  const locale = await getRequestLocale(session.user.id)
  const dictionaries = await getDictionaries(locale, DASHBOARD_AI_DOMAINS)
  const t = await getTranslator(locale, "ai")

  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />

      <div className="p-4 sm:p-6">
        <TranslationProvider dictionaries={dictionaries}>
          <AiManager />
        </TranslationProvider>
      </div>
    </div>
  )
}
