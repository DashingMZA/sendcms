import { requireDashboardSession } from "@/lib/require-session"
import { getUserAuthMethods } from "@sendcms/users"

import { getConfiguredOAuthProviders } from "@sendcms/auth"

import { PageHeader } from "@/components/dashboard/page-header"
import { PageContent } from "@/components/dashboard/page-content"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Separator,
} from "@sendcms/ui"

import {
  DASHBOARD_ACCOUNT_DOMAINS,
  getDictionaries,
  getRequestLocale,
  getTranslator,
} from "@/lib/i18n"
import { TranslationProvider } from "@/components/dashboard/translation-provider"
import { SignOutButton } from "./sign-out-button"
import { ResendVerificationButton } from "./resend-verification-button"
import { UpdateNameForm } from "./update-name-form"
import { ChangeEmailForm } from "./change-email-form"
import { ChangePasswordForm } from "./change-password-form"
import { LinkProviderButtons } from "./link-provider-buttons"

export default async function AccountPage() {
  const session = await requireDashboardSession()
  const { id, name, email, image, emailVerified } = session.user
  const { hasPassword, providers } = await getUserAuthMethods(id)
  const configured = getConfiguredOAuthProviders()
  const unlinked = configured.filter((p) => !providers.includes(p))

  const locale = await getRequestLocale(id)
  const dictionaries = await getDictionaries(locale, DASHBOARD_ACCOUNT_DOMAINS)
  const t = await getTranslator(locale, "account")

  const PROVIDER_LABEL: Record<string, string> = {
    google: "Google",
    github: "GitHub",
    facebook: "Facebook",
    credential: t("providerEmailPassword"),
  }
  const providerNames = providers.map((p) => PROVIDER_LABEL[p] ?? p).join(", ")

  const initials = (name ?? email ?? "U").slice(0, 2).toUpperCase()

  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />
      <TranslationProvider dictionaries={dictionaries}>
        <PageContent className="max-w-md">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("profileTitle")}</CardTitle>
              <CardDescription>
                {t("signedInVia", { providers: providerNames })}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-4">
                <Avatar className="size-14">
                  <AvatarImage src={image ?? ""} alt={name ?? ""} />
                  <AvatarFallback>{initials}</AvatarFallback>
                </Avatar>
                <div>
                  <p className="font-semibold">{name}</p>
                  <p className="text-sm text-muted-foreground">{email}</p>
                  <div className="mt-1">
                    {emailVerified ? (
                      <Badge variant="secondary">{t("emailVerified")}</Badge>
                    ) : (
                      <Badge variant="destructive">
                        {t("emailNotVerified")}
                      </Badge>
                    )}
                  </div>
                </div>
              </div>
              {!emailVerified && (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">
                    {t("verifyEmailHint")}
                  </p>
                  <ResendVerificationButton email={email} />
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("nameTitle")}</CardTitle>
              <CardDescription>{t("nameDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              <UpdateNameForm currentName={name} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("emailTitle")}</CardTitle>
              <CardDescription>{t("emailDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              <ChangeEmailForm currentEmail={email} />
            </CardContent>
          </Card>

          {hasPassword && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {t("passwordTitle")}
                </CardTitle>
                <CardDescription>{t("passwordDescription")}</CardDescription>
              </CardHeader>
              <CardContent>
                <ChangePasswordForm />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("connectedTitle")}</CardTitle>
              <CardDescription>
                {providers.length > 0
                  ? t("connectedDescription", { providers: providerNames })
                  : t("noAccounts")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <LinkProviderButtons providers={unlinked} />
              {unlinked.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {t("allConnected")}
                </p>
              )}
            </CardContent>
          </Card>

          <Separator />

          <SignOutButton />
        </PageContent>
      </TranslationProvider>
    </div>
  )
}
