import { auth } from "@/lib/auth"
import { listApiKeysForUser } from "@sendcms/api-keys"

import { PageHeader } from "@/components/dashboard/page-header"

import {
  DASHBOARD_API_KEYS_DOMAINS,
  getDictionaries,
  getRequestLocale,
  getTranslator,
} from "@/lib/i18n"
import { TranslationProvider } from "@/components/dashboard/translation-provider"
import { ApiKeysManager } from "./api-keys-manager"

export default async function ApiKeysPage() {
  const session = await auth()
  const keys = await listApiKeysForUser(session!.user!.id as string)

  const locale = await getRequestLocale(session!.user!.id as string)
  const dictionaries = await getDictionaries(locale, DASHBOARD_API_KEYS_DOMAINS)
  const t = await getTranslator(locale, "api-keys")

  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />

      <div className="p-4 sm:p-6">
        <TranslationProvider dictionaries={dictionaries}>
          <ApiKeysManager initialKeys={keys} />
        </TranslationProvider>
      </div>
    </div>
  )
}
