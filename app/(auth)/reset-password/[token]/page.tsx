import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { AuthShell } from "../../auth-shell"
import { ResetPasswordForm } from "./reset-password-form"

export default async function ResetPasswordPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const session = await auth()
  if (session) redirect("/dashboard")
  const { token } = await params

  return (
    <AuthShell
      title="Choose a new password"
      description="Enter a new password for your account."
    >
      <ResetPasswordForm token={token} />
    </AuthShell>
  )
}
