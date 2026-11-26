import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { SidebarInset, SidebarProvider, TooltipProvider } from "@sendcms/ui"

import { AppSidebar } from "@/components/admin/app-sidebar"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { getLocaleDirection, getRequestLocale } from "@/lib/i18n"
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

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar
          user={session.user}
          side={side}
          initialLocale={locale}
          newTicketCount={newTicketCount}
        />
        <SidebarInset>{children}</SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
