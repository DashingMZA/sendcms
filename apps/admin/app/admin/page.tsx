import type { Metadata } from "next"
import Link from "next/link"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@sendcms/ui"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"

export const metadata: Metadata = {
  title: "Overview — SendCMS Admin",
  description: "Platform administration overview.",
}

// Admin overview (Phase 2 shell). Honest by design: it shows only real
// data — the signed-in admin, the admin host, and the planned sections
// with the phase each lands in. Platform statistics arrive in Phase 3;
// there are no fake stats or placeholder charts here.
export default async function AdminOverviewPage() {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  const locale = await getRequestLocale()
  const t = await getTranslator(locale, "dashboard")
  const tNav = await getTranslator(locale, "navigation")
  const tProfile = await getTranslator(locale, "profile")
  const tAdmins = await getTranslator(locale, "admins")

  const sections = [
    { href: "/admin/users", label: tNav("users"), phase: 3 },
    { href: "/admin/plans", label: tNav("plans"), phase: 4 },
    { href: "/admin/ai", label: tNav("ai"), phase: 5 },
    { href: "/admin/mcp", label: tNav("mcp"), phase: 6 },
    { href: "/admin/audit-logs", label: tNav("auditLogs"), phase: 7 },
    { href: "/admin/settings", label: tNav("settings"), phase: 7 },
  ]

  const user = session.user

  return (
    <main id="main-content" className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground">
          {t("welcome", { name: user.name ?? user.email ?? "" })}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("overviewDescription")}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{tProfile("title")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-medium">{user.name ?? user.email}</p>
            <p className="text-sm text-muted-foreground">{user.email}</p>
            <p className="mt-3 text-sm">
              {tAdmins("role")}:{" "}
              <Badge variant="secondary">{user.platformRole}</Badge>
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("adminHost")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-sm break-all">{adminBaseURL()}</p>
            <p className="mt-3 text-sm text-muted-foreground">
              {t("adminHostDescription")}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("plannedSections")}</CardTitle>
          <CardDescription>{t("plannedSectionsDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-2">
            {sections.map((section) => (
              <li key={section.href}>
                <Link
                  href={section.href}
                  className="flex items-center justify-between gap-4 rounded-md border px-4 py-3 hover:bg-accent"
                >
                  <span className="font-medium">{section.label}</span>
                  <Badge variant="secondary">
                    {t("phase", { number: section.phase })}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </main>
  )
}
