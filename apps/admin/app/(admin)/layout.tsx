import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { SidebarInset, SidebarProvider, TooltipProvider } from "@sendcms/ui"

import { AppSidebar } from "@/components/admin/app-sidebar"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const session = await auth()
  // The proxy already redirects unauthenticated users to sign-in; this
  // is the same check as defense-in-depth for direct renders.
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar user={session.user} />
        <SidebarInset>{children}</SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
