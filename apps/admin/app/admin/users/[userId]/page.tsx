import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { notFound, redirect } from "next/navigation"
import { getUserDetail } from "@sendcms/admin-users"
import { getUserAiBillingMode } from "@sendcms/ai-settings"
import { getUserMcpSettings, type UserMcpSettingsRow } from "@sendcms/mcp-admin"
import { MCP_TOOL_NAMES } from "@sendcms/mcp"
import { ApiError } from "@sendcms/shared"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { UserDetail } from "@/components/admin/user-detail"

export const metadata: Metadata = {
  title: "User — SendCMS Admin",
  description: "Inspect and manage a platform user.",
}

// Admin user detail (Phase 3). The server fetches the detail via the
// service layer and passes it as initialData; the client component owns
// the tabs and every admin action. The actor's effective role goes down
// as props so the UI can hide actions the actor cannot perform — the
// service enforces authorization server-side regardless.
export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ userId: string }>
}) {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const { userId } = await params
  let detail
  try {
    detail = await getUserDetail(session, userId)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound()
    throw err
  }

  const actorRole =
    session.user.platformRole === "PLATFORM_OWNER"
      ? "PLATFORM_OWNER"
      : (session.user.adminRole ?? "PLATFORM_USER")

  // The AI tab's billing mode (Phase 5) — a plain read of the user's
  // AI settings row; the tab's mutations go through the api app.
  const aiBillingMode = await getUserAiBillingMode(userId)

  // The MCP tab's per-user settings (Phase 6). A failed read (the
  // actor lacks VIEW_MCP) must not break the whole page — the tab
  // shows its no-permission card instead.
  let mcpSettings: UserMcpSettingsRow | null = null
  try {
    mcpSettings = await getUserMcpSettings(session, userId)
  } catch {
    mcpSettings = null
  }

  return (
    <UserDetail
      initialData={detail}
      userId={userId}
      actorId={session.user.id}
      actorRole={actorRole}
      aiBillingMode={aiBillingMode}
      mcpSettings={mcpSettings}
      mcpToolNames={MCP_TOOL_NAMES}
    />
  )
}
