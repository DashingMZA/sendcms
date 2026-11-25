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
import { getUserAiBillingMode, listUserAiKeys } from "@sendcms/ai-settings"
import { AiManager } from "./ai-manager"

// The customer's AI page (Phase 5 — BYOK). AIM-013 / SRC-110: the
// server fetches the saved keys and billing mode and passes them as
// initialData, so the mode selector and key cards render in the SSR
// HTML instead of after the client fetch. Browser-only keys never
// reach this server at all.
export default async function AiPage() {
  const session = await auth()
  if (!session?.user) redirect("/sign-in")

  const [initialKeys, initialBillingMode] = await Promise.all([
    listUserAiKeys(session.user.id),
    getUserAiBillingMode(session.user.id),
  ])

  const locale = await getRequestLocale(session.user.id)
  const dictionaries = await getDictionaries(locale, DASHBOARD_AI_DOMAINS)
  const t = await getTranslator(locale, "ai")

  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />

      <div className="p-4 sm:p-6">
        <TranslationProvider dictionaries={dictionaries}>
          <AiManager
            initialKeys={initialKeys}
            initialBillingMode={initialBillingMode}
          />
        </TranslationProvider>
      </div>
    </div>
  )
}
