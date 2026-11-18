import { notFound } from "next/navigation"
import { auth } from "@/lib/auth"
import { ApiError } from "@/lib/api/error"
import { getDomainForUser } from "@sendcms/domains"

import { PageHeader } from "@/components/dashboard/page-header"
import { DomainDetail } from "./domain-detail"

export default async function DomainDetailPage({
  params,
}: {
  params: Promise<{ domainId: string }>
}) {
  const session = await auth()
  const { domainId } = await params
  let domain: Awaited<ReturnType<typeof getDomainForUser>> | null = null
  try {
    domain = await getDomainForUser(session!.user!.id as string, domainId)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound()
    throw err
  }
  if (!domain) notFound()

  return (
    <div>
      <PageHeader
        title={domain.domain}
        description="Domain ownership and verification"
      />

      <div className="p-4 sm:p-6">
        <DomainDetail initialDomain={domain} />
      </div>
    </div>
  )
}
