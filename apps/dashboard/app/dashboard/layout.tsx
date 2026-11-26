import { auth } from "@/lib/auth"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { SidebarInset, SidebarProvider, TooltipProvider } from "@sendcms/ui"

import { AppSidebar } from "@/components/dashboard/app-sidebar"
import { QueryProvider } from "@/components/dashboard/query-provider"
import {
  LocaleProvider,
  TranslationProvider,
} from "@/components/dashboard/translation-provider"
import {
  DASHBOARD_SHELL_DOMAINS,
  getDictionaries,
  getLocaleDirection,
  getRequestLocale,
} from "@/lib/i18n"
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

  // The sidebar sits on the inline-start side: left in LTR, right in
  // RTL. The shadcn Sidebar pins itself with PHYSICAL left/right
  // (data-[side=left]:left-0 / data-[side=right]:right-0), so
  // dir="rtl" on <html> alone does NOT move it — the side must be
  // passed explicitly. Language switching reloads the page, so this
  // server-computed direction is never stale. The session user id is
  // passed (DSH-001/DSH-201/DSH-401) so the stored DB preference
  // resolves for the shell dictionaries and the sidebar side too.
  const locale = await getRequestLocale(session.user.id)
  const side = getLocaleDirection(locale) === "rtl" ? "right" : "left"
  const dictionaries = await getDictionaries(locale, DASHBOARD_SHELL_DOMAINS)

  // UX-006: the sidebar's open/collapsed state survives reloads — the
  // client persists it in the `sidebar_state` cookie and the server
  // reads it here so the first paint already matches.
  const sidebarState = (await cookies()).get("sidebar_state")?.value
  const sidebarDefaultOpen = sidebarState !== "false"

  return (
    <QueryProvider>
      <LocaleProvider locale={locale}>
        <TranslationProvider dictionaries={dictionaries}>
          <TooltipProvider>
            <SidebarProvider defaultOpen={sidebarDefaultOpen}>
              <AppSidebar
                user={session.user}
                domainCount={domainCount}
                formCount={formCount}
                inboxCount={inboxCount}
                side={side}
                initialLocale={locale}
              />
              <SidebarInset>{children}</SidebarInset>
            </SidebarProvider>
          </TooltipProvider>
        </TranslationProvider>
      </LocaleProvider>
    </QueryProvider>
  )
}
