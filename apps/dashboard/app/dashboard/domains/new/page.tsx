import Link from "next/link"
import { auth } from "@/lib/auth"
import { PageHeader } from "@/components/dashboard/page-header"
import { Button } from "@sendcms/ui"

import {
  DASHBOARD_DOMAINS_DOMAINS,
  getDictionaries,
  getRequestLocale,
  getTranslator,
} from "@/lib/i18n"
import { TranslationProvider } from "@/components/dashboard/translation-provider"
import { AddDomainForm } from "./add-domain-form"

export default async function NewDomainPage() {
  const session = await auth()
  const emailVerified = session?.user?.emailVerified ?? false

  const locale = await getRequestLocale(session?.user?.id)
  const dictionaries = await getDictionaries(locale, DASHBOARD_DOMAINS_DOMAINS)
  const t = await getTranslator(locale, "domains")

  return (
    <div>
      <PageHeader title={t("newTitle")} description={t("newDescription")} />

      <div className="p-4 sm:p-6">
        {emailVerified ? (
          <TranslationProvider dictionaries={dictionaries}>
            <AddDomainForm />
          </TranslationProvider>
        ) : (
          <div className="flex max-w-lg flex-col gap-4 rounded-lg border border-dashed p-6">
            <h3 className="text-lg font-semibold">
              {t("emailVerificationRequired")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("emailVerificationDescription")}
            </p>
            <div>
              <Button asChild size="sm">
                <Link href="/dashboard/account">{t("goToAccount")}</Link>
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
