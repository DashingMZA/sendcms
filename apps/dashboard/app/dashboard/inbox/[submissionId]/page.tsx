import { notFound } from "next/navigation"
import { auth } from "@/lib/auth"
import { getSubmissionForUser } from "@sendcms/inbox"
import { ApiError } from "@sendcms/api-client"

import { PageHeader } from "@/components/dashboard/page-header"
import { SubmissionDetail } from "../submission-detail"

type Params = { params: Promise<{ submissionId: string }> }

export default async function SubmissionDetailPage({ params }: Params) {
  const { submissionId } = await params
  const session = await auth()
  let submission
  try {
    submission = await getSubmissionForUser(
      session!.user!.id as string,
      submissionId
    )
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound()
    throw err
  }

  return (
    <div>
      <PageHeader
        title="Submission"
        description={`From ${submission.form.name} · ${submission.originDomain}`}
      />
      <div className="p-4 sm:p-6">
        <SubmissionDetail initialData={submission} />
      </div>
    </div>
  )
}
