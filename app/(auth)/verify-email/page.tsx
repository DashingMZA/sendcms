import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { AuthShell } from "../auth-shell"
import { VerifyEmailHandler } from "./verify-email-handler"

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; callbackURL?: string }>
}) {
  const session = await auth()
  if (session) redirect("/dashboard")
  const { token, callbackURL } = await searchParams

  return (
    <AuthShell
      title="Verify your email"
      description="We're confirming your email address."
    >
      <VerifyEmailHandler token={token} callbackURL={callbackURL} />
    </AuthShell>
  )
}
