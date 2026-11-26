import { auth } from "@/lib/auth"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { SidebarInset, SidebarProvider, TooltipProvider } from "@sendcms/ui"

import { AppSidebar } from "@/components/admin/app-sidebar"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { getLocaleDirection, getRequestLocale } from "@/lib/i18n"
import { listDeletionRequests } from "@sendcms/platform-ops"
import { countNewTickets } from "@sendcms/support"

// NOTE: this layout lives at app/admin/layout.tsx (NOT in the (admin)
// route group) because it must wrap /admin/*. A layout inside a route
// group only wraps pages inside that group — the old
// app/(admin)/layout.tsx never wrapped any page, so the admin app
// rendered without its sidebar. Same shape as the dashboard's
// app/dashboard/layout.tsx.
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await auth()
  // The proxy already redirects unauthenticated users to sign-in; this
  // is the same check as defense-in-depth for direct renders.
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  // The sidebar sits on the inline-start side: left in LTR, right in
  // RTL. The shadcn Sidebar pins itself with PHYSICAL left/right
  // (data-[side=left]:left-0 / data-[side=right]:right-0), so
  // dir="rtl" on <html> alone does NOT move it — the side must be
  // passed explicitly. Language switching reloads the page, so this
  // server-computed direction is never stale. The session user id is
  // passed (I18N-203) so the stored DB preference resolves for the
  // sidebar side too.
  const locale = await getRequestLocale(session.user.id)
  const side = getLocaleDirection(locale) === "rtl" ? "right" : "left"

  // DSH-406 (owner decision 2026-11-25, option (b)): staff see the
  // new-ticket count in the admin shell, NOT by email/notification.
  // Best-effort: a failed count must never break the shell, so it
  // degrades to no badge instead of a failed page.
  let newTicketCount = 0
  try {
    newTicketCount = await countNewTickets(session)
  } catch {
    newTicketCount = 0
  }

  // Wave 10, UX-013: the pending-deletion-request count for the
  // Security nav badge — same best-effort shape. Only the total is
  // needed, so one row is fetched. Actors without MANAGE_USERS
  // (e.g. SUPPORT) cannot review deletions; the count degrades to
  // no badge for them instead of breaking the shell.
  let pendingDeletionCount = 0
  try {
    const { total } = await listDeletionRequests(session, {
      status: "REQUESTED",
      page: 1,
      perPage: 1,
    })
    pendingDeletionCount = total
  } catch {
    pendingDeletionCount = 0
  }

  // UX-006: the sidebar writes its collapse state to the
  // `sidebar_state` cookie on every toggle — read it here so the
  // choice survives a full page load instead of resetting to
  // expanded. Absent (or anything but "false") means expanded.
  const sidebarState = (await cookies()).get("sidebar_state")?.value

  return (
    <TooltipProvider>
      <SidebarProvider defaultOpen={sidebarState !== "false"}>
        <AppSidebar
          user={session.user}
          side={side}
          initialLocale={locale}
          newTicketCount={newTicketCount}
          pendingDeletionCount={pendingDeletionCount}
        />
        <SidebarInset>{children}</SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
