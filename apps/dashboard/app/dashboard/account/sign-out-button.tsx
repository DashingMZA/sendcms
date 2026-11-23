"use client"

import { useRouter } from "next/navigation"
import { authClient } from "@sendcms/auth/client"

import { Button } from "@sendcms/ui"
import { useTranslation } from "@/components/dashboard/translation-provider"

/** Sign-out button (Better Auth: client-side signOut, then /sign-in). */
export function SignOutButton() {
  const { t } = useTranslation("account")
  const router = useRouter()
  return (
    <Button
      variant="outline"
      type="button"
      onClick={() =>
        authClient.signOut({
          fetchOptions: {
            onSuccess: () => {
              router.push("/sign-in")
            },
          },
        })
      }
    >
      {t("signOut")}
    </Button>
  )
}
