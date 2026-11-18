"use client"

import { authClient } from "@/lib/auth-client"
import { Button } from "@sendcms/ui"

import type { OAuthProviderId } from "@/lib/auth-providers"

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
          Connect {PROVIDER_LABEL[provider]}
        </Button>
      ))}
    </div>
  )
}
