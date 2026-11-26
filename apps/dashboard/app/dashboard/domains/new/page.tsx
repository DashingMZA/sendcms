import Link from "next/link"
import { auth } from "@/lib/auth"
import { PageHeader } from "@/components/dashboard/page-header"
import { PageContent } from "@/components/dashboard/page-content"
import { Button, Callout } from "@sendcms/ui"

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

      <PageContent>
        {emailVerified ? (
          <TranslationProvider dictionaries={dictionaries}>
            <AddDomainForm />
          </TranslationProvider>
        ) : (
          // UX-113: a blocking notice is not an empty state — it gets
          // the shared warning callout, not the dashed empty box.
          <div className="max-w-lg">
            <Callout title={t("emailVerificationRequired")}>
              <p>{t("emailVerificationDescription")}</p>
              <div>
                <Button asChild size="sm">
                  <Link href="/dashboard/account">{t("goToAccount")}</Link>
                </Button>
              </div>
            </Callout>
          </div>
        )}
      </PageContent>
    </div>
  )
}
