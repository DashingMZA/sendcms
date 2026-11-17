import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AppSidebar } from "@/components/dashboard/app-sidebar"
import { getSiteCountForUser } from "@/lib/services/site-service"
import { getDomainCountForUser } from "@/lib/services/domain-service"

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await auth()
  if (!session?.user) redirect("/sign-in")

  const [siteCount, domainCount] = await Promise.all([
    getSiteCountForUser(session.user.id),
    getDomainCountForUser(session.user.id),
  ])

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar
          user={session.user}
          siteCount={siteCount}
          domainCount={domainCount}
          platformRole={session.user.platformRole}
        />
        <SidebarInset>{children}</SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
