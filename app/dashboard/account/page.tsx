import { auth } from "@/lib/auth"
import { getUserAuthMethods } from "@/lib/services/user-service"
import { getConfiguredOAuthProviders } from "@/lib/auth-providers"

import { PageHeader } from "@/components/dashboard/page-header"
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

import { SignOutButton } from "./sign-out-button"
import { ResendVerificationButton } from "./resend-verification-button"
import { UpdateNameForm } from "./update-name-form"
import { ChangeEmailForm } from "./change-email-form"
import { ChangePasswordForm } from "./change-password-form"
import { LinkProviderButtons } from "./link-provider-buttons"

const PROVIDER_LABEL: Record<string, string> = {
  google: "Google",
  github: "GitHub",
  facebook: "Facebook",
  credential: "Email & password",
}

export default async function AccountPage() {
  const session = await auth()
  const { id, name, email, image, emailVerified } = session!.user
  const { hasPassword, providers } = await getUserAuthMethods(id)
  const configured = getConfiguredOAuthProviders()
  const unlinked = configured.filter((p) => !providers.includes(p))

  const initials = (name ?? email ?? "U").slice(0, 2).toUpperCase()

  return (
    <div>
      <PageHeader
        title="Account"
        description="Your profile and sign-in methods"
      />
      <div className="flex max-w-md flex-col gap-6 p-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Profile</CardTitle>
            <CardDescription>
              Signed in via{" "}
              {providers.map((p) => PROVIDER_LABEL[p] ?? p).join(", ")}
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
                    <Badge variant="secondary">Email verified</Badge>
                  ) : (
                    <Badge variant="destructive">Email not verified</Badge>
                  )}
                </div>
              </div>
            </div>
            {!emailVerified && (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  Verify your email to register domains and receive submissions.
                  Until then your account works, but domain registration stays
                  locked.
                </p>
                <ResendVerificationButton email={email} />
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Name</CardTitle>
            <CardDescription>Shown on your profile.</CardDescription>
          </CardHeader>
          <CardContent>
            <UpdateNameForm currentName={name} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Email address</CardTitle>
            <CardDescription>
              The verification link goes to the new address first.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ChangeEmailForm currentEmail={email} />
          </CardContent>
        </Card>

        {hasPassword && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Password</CardTitle>
              <CardDescription>
                Changing it signs out your other sessions.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ChangePasswordForm />
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Connected accounts</CardTitle>
            <CardDescription>
              {providers.length > 0
                ? `Connected: ${providers.map((p) => PROVIDER_LABEL[p] ?? p).join(", ")}`
                : "No accounts connected."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LinkProviderButtons providers={unlinked} />
            {unlinked.length === 0 && (
              <p className="text-sm text-muted-foreground">
                All configured providers are connected.
              </p>
            )}
          </CardContent>
        </Card>

        <Separator />

        <SignOutButton />
      </div>
    </div>
  )
}
