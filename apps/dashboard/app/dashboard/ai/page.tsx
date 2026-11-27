import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { PageHeader } from "@/components/dashboard/page-header"
import { PageContent } from "@/components/dashboard/page-content"
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
// Page <title> follows the page locale (I18N-204): the title is the same
// key the <h1> renders, so title == heading. (SRC-113: every dashboard
// page exports metadata; the layout template appends "— SendCMS Dashboard".)
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "ai")
  return {
    title: t("title"),
    description: t("description"),
  }
}

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

      <PageContent>
        <TranslationProvider dictionaries={dictionaries}>
          <AiManager
            initialKeys={initialKeys}
            initialBillingMode={initialBillingMode}
          />
        </TranslationProvider>
      </PageContent>
    </div>
  )
}
