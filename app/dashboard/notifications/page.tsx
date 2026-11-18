import { auth } from "@/lib/auth"
import { PageHeader } from "@/components/dashboard/page-header"
import { listEmailJobsForUser } from "@/lib/services/email-outbox"
import { listFormsForUser } from "@/lib/services/form-service"
import { EmailJobListQuerySchema } from "@/lib/validators/email-jobs"
import { EmailJobsTable } from "./email-jobs-table"

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function NotificationsPage({ searchParams }: Props) {
  const session = await auth()
  const userId = session!.user!.id as string

  const raw = await searchParams
  const flat: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") flat[key] = value
  }
  const parsed = EmailJobListQuerySchema.safeParse(flat)
  const params = parsed.success ? parsed.data : { page: 1 }

  const [list, forms] = await Promise.all([
    listEmailJobsForUser(userId, params),
    listFormsForUser(userId),
  ])

  return (
    <div>
      <PageHeader
        title="Notifications"
        description="Delivery log for submission notification emails — sent, pending and failed"
      />
      <div className="p-4 sm:p-6">
        <EmailJobsTable
          initialData={list}
          params={params}
          forms={forms.map((form) => ({ id: form.id, name: form.name }))}
        />
      </div>
    </div>
  )
}
