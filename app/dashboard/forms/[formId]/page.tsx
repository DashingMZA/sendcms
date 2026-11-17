import { notFound } from "next/navigation"
import { auth } from "@/lib/auth"
import { getFormForUser } from "@/lib/services/form-service"
import { PageHeader } from "@/components/dashboard/page-header"
import { ApiError } from "@/lib/api/error"
import { FormDetail } from "./form-detail"

type Params = { params: Promise<{ formId: string }> }

export default async function FormDetailPage({ params }: Params) {
  const { formId } = await params
  const session = await auth()
  let form
  try {
    form = await getFormForUser(session!.user!.id as string, formId)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound()
    throw err
  }

  return (
    <div>
      <PageHeader
        title={form.name}
        description="Form settings, fields, allowed domains and notifications"
      />

      <div className="p-4 sm:p-6">
        <FormDetail
          initialForm={form}
          appUrl={process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}
        />
      </div>
    </div>
  )
}
