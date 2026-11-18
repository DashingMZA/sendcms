import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { SidebarInset, SidebarProvider, TooltipProvider } from "@sendcms/ui"

import { AppSidebar } from "@/components/dashboard/app-sidebar"
import { getDomainCountForUser } from "@sendcms/domains"
import { getFormCountForUser } from "@sendcms/forms"
import { getUnreadSubmissionCountForUser } from "@sendcms/inbox"

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await auth()
  if (!session?.user) redirect("/sign-in")

  const [domainCount, formCount, inboxCount] = await Promise.all([
    getDomainCountForUser(session.user.id),
    getFormCountForUser(session.user.id),
    getUnreadSubmissionCountForUser(session.user.id),
  ])

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar
          user={session.user}
          domainCount={domainCount}
          formCount={formCount}
          inboxCount={inboxCount}
        />
        <SidebarInset>{children}</SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
