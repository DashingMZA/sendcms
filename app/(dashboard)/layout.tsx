import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppSidebar } from "@/components/dashboard/app-sidebar"
import { getSiteCountForUser } from "@/lib/services/site-service"
import { getDomainCountForUser } from "@/lib/services/domain-service"
import { getFormCountForUser } from "@/lib/services/form-service"
import { getUnreadSubmissionCountForUser } from "@/lib/services/submission-service"

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await auth()
  if (!session?.user) redirect("/sign-in")

  const [siteCount, domainCount, formCount, inboxCount] = await Promise.all([
    getSiteCountForUser(session.user.id),
    getDomainCountForUser(session.user.id),
    getFormCountForUser(session.user.id),
    getUnreadSubmissionCountForUser(session.user.id),
  ])

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar
          user={session.user}
          siteCount={siteCount}
          domainCount={domainCount}
          formCount={formCount}
          inboxCount={inboxCount}
          platformRole={session.user.platformRole}
        />
        <SidebarInset>{children}</SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
