import Link from "next/link"
import { auth } from "@/lib/auth"
import { listDomainsForUser } from "@sendcms/domains"

import { PageHeader } from "@/components/dashboard/page-header"
import { Button } from "@sendcms/ui"

import { RiAddLine } from "@remixicon/react"
import { DomainsTable } from "./domains-table"

export default async function DomainsPage() {
  const session = await auth()
  const domains = await listDomainsForUser(session!.user!.id as string)

  return (
    <div>
      <PageHeader
        title="Domains"
        description="Register and verify the domains your forms accept submissions from"
        action={
          <Button asChild size="sm">
            <Link href="/dashboard/domains/new">
              <RiAddLine className="size-4" aria-hidden="true" />
              Add domain
            </Link>
          </Button>
        }
      />

      <div className="p-4 sm:p-6">
        <DomainsTable initialDomains={domains} />
      </div>
    </div>
  )
}
