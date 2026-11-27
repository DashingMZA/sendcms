import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { requireDashboardSession } from "@/lib/require-session"
import { listApiKeysForUser } from "@sendcms/api-keys"

import { PageHeader } from "@/components/dashboard/page-header"
import { PageContent } from "@/components/dashboard/page-content"

import { Button } from "@sendcms/ui"

import {
  DASHBOARD_API_KEYS_DOMAINS,
  getDictionaries,
  getRequestLocale,
  getTranslator,
} from "@/lib/i18n"
import { TranslationProvider } from "@/components/dashboard/translation-provider"
import { ApiKeysManager } from "./api-keys-manager"

// Page <title> follows the page locale (I18N-204): the title is the same
// key the <h1> renders, so title == heading. (SRC-113: every dashboard
// page exports metadata; the layout template appends "— SendCMS Dashboard".)
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "api-keys")
  return {
    title: t("title"),
    description: t("description"),
  }
}

export default async function ApiKeysPage() {
  const session = await requireDashboardSession()
  const keys = await listApiKeysForUser(session.user.id)

  const locale = await getRequestLocale(session.user.id)
  const dictionaries = await getDictionaries(locale, DASHBOARD_API_KEYS_DOMAINS)
  const t = await getTranslator(locale, "api-keys")

  return (
    <div>
      <PageHeader
        title={t("title")}
        description={t("description")}
        action={
          // UX-110: the page's single primary action — the create
          // form's submit, wired by form="create-api-key-form" (the
          // form itself lives in ApiKeysManager below).
          <Button type="submit" form="create-api-key-form">
            {t("createKey")}
          </Button>
        }
      />

      <PageContent>
        <TranslationProvider dictionaries={dictionaries}>
          <ApiKeysManager initialKeys={keys} />
        </TranslationProvider>
      </PageContent>
    </div>
  )
}
