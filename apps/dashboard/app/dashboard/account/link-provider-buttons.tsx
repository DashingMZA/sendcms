"use client"

import type { OAuthProviderId } from "@sendcms/auth"
import { authClient } from "@sendcms/auth/client"

import { Button } from "@sendcms/ui"
import { useTranslation } from "@/components/dashboard/translation-provider"

const PROVIDER_LABEL: Record<OAuthProviderId, string> = {
  google: "Google",
  github: "GitHub",
  facebook: "Facebook",
}

/** Link an additional OAuth provider to the signed-in account. */
export function LinkProviderButtons({
  providers,
}: {
  providers: OAuthProviderId[]
}) {
  const { t } = useTranslation("account")
  if (providers.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2">
      {providers.map((provider) => (
        <Button
          key={provider}
          type="button"
          variant="outline"
          onClick={() =>
            authClient.linkSocial({
              provider,
              callbackURL: "/dashboard/account",
            })
          }
        >
          {t("connectProvider", { provider: PROVIDER_LABEL[provider] })}
        </Button>
      ))}
    </div>
  )
}
