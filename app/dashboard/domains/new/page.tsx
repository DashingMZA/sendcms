import Link from "next/link"
import { auth } from "@/lib/auth"
import { PageHeader } from "@/components/dashboard/page-header"
import { Button } from "@sendcms/ui"

import { AddDomainForm } from "./add-domain-form"

export default async function NewDomainPage() {
  const session = await auth()
  const emailVerified = session?.user?.emailVerified ?? false

  return (
    <div>
      <PageHeader
        title="Add domain"
        description="Register a domain, then prove you own it"
      />

      <div className="p-4 sm:p-6">
        {emailVerified ? (
          <AddDomainForm />
        ) : (
          <div className="flex max-w-lg flex-col gap-4 rounded-lg border border-dashed p-6">
            <h3 className="text-lg font-semibold">
              Email verification required
            </h3>
            <p className="text-sm text-muted-foreground">
              Verify your email before registering a domain. Until then your
              account works, but domain registration stays locked.
            </p>
            <div>
              <Button asChild size="sm">
                <Link href="/dashboard/account">Go to account settings</Link>
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
