import Link from "next/link"
import { auth } from "@/lib/auth"
import { listFormsForUser } from "@/lib/services/form-service"
import { PageHeader } from "@/components/dashboard/page-header"
import { Button } from "@sendcms/ui"

import { RiAddLine } from "@remixicon/react"
import { FormsTable } from "./forms-table"

export default async function FormsPage() {
  const session = await auth()
  const forms = await listFormsForUser(session!.user!.id as string)

  return (
    <div>
      <PageHeader
        title="Forms"
        description="Contact forms that collect submissions from your verified domains"
        action={
          <Button asChild size="sm">
            <Link href="/dashboard/forms/new">
              <RiAddLine className="size-4" aria-hidden="true" />
              New form
            </Link>
          </Button>
        }
      />

      <div className="p-4 sm:p-6">
        <FormsTable initialForms={forms} />
      </div>
    </div>
  )
}
