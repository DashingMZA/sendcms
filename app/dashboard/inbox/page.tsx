import { auth } from "@/lib/auth"
import { PageHeader } from "@/components/dashboard/page-header"
import { listSubmissionsForUser } from "@/lib/services/submission-service"
import { listFormsForUser } from "@/lib/services/form-service"
import { listDomainsForUser } from "@/lib/services/domain-service"
import { InboxListQuerySchema } from "@/lib/validators/inbox"
import { InboxTable } from "./inbox-table"

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function InboxPage({ searchParams }: Props) {
  const session = await auth()
  const userId = session!.user!.id as string

  const raw = await searchParams
  const flat: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") flat[key] = value
  }
  const parsed = InboxListQuerySchema.safeParse(flat)
  const params = parsed.success ? parsed.data : { tab: "all" as const, page: 1 }

  const [list, forms, domains] = await Promise.all([
    listSubmissionsForUser(userId, params),
    listFormsForUser(userId),
    listDomainsForUser(userId),
  ])

  return (
    <div>
      <PageHeader
        title="Inbox"
        description="Submissions from your forms — read, star, archive or mark spam"
      />
      <div className="p-4 sm:p-6">
        <InboxTable
          initialData={list}
          params={params}
          forms={forms.map((form) => ({ id: form.id, name: form.name }))}
          domains={domains.map((domain) => ({ domain: domain.domain }))}
        />
      </div>
    </div>
  )
}
