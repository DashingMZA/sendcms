import { auth } from "@/lib/auth"
import { listApiKeysForUser } from "@sendcms/api-keys"

import { PageHeader } from "@/components/dashboard/page-header"

import { ApiKeysManager } from "./api-keys-manager"

export default async function ApiKeysPage() {
  const session = await auth()
  const keys = await listApiKeysForUser(session!.user!.id as string)

  return (
    <div>
      <PageHeader
        title="API Keys"
        description="Bearer keys for the MCP endpoint — connect Claude Desktop, your IDE, or any agent to SendCMS"
      />

      <div className="p-4 sm:p-6">
        <ApiKeysManager initialKeys={keys} />
      </div>
    </div>
  )
}
