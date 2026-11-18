"use client"

import { useRouter } from "next/navigation"
import { authClient } from "@sendcms/auth/client"

import { Button } from "@sendcms/ui"

/** Sign-out button (Better Auth: client-side signOut, then /sign-in). */
export function SignOutButton() {
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
      Sign out
    </Button>
  )
}
