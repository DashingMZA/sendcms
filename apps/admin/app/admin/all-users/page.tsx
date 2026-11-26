import type { Metadata } from "next"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { listUsers } from "@sendcms/admin-users"
import { AdminUserListQuerySchema } from "@sendcms/admin-users/validators"
import { getRequestLocale, getTranslator } from "@/lib/i18n"
import { adminBaseURL, dashboardSignInURL } from "@/lib/callback-url"
import { PageHeader } from "@/components/admin/page-header"
import { UsersTable } from "@/components/admin/users-table"

// Page <title> follows the page locale (I18N-204): the title
// is the same key the <h1> renders, so title == heading.
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "users")
  return {
    title: `${t("title")} — SendCMS Admin`,
    description: t("description"),
  }
}

// Admin user list (Phase 3). The server fetches the first page via the
// service layer and passes it as initialData; the client table owns
// search, filters, and pagination from there (URL-as-state, like the
// dashboard inbox).
export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const session = await auth()
  if (!session?.user) redirect(dashboardSignInURL(`${adminBaseURL()}/admin`))

  // SRC-119: one invalid-input policy for list pages — an invalid
  // query param falls back to the schema defaults, never throws.
  // `.parse()` here used to 500 on `?page=abc` (the error boundary),
  // while the dashboard inbox silently fell back to its defaults;
  // both pages now do the same thing.
  const raw = await searchParams
  const parsed = AdminUserListQuerySchema.safeParse(raw)
  const filters = parsed.success
    ? parsed.data
    : AdminUserListQuerySchema.parse({})
  const initialData = await listUsers(session, filters)

  const locale = await getRequestLocale(session.user.id)
  const t = await getTranslator(locale, "users")

  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />
      <main id="main-content" className="flex flex-col gap-6 p-6">
        <UsersTable initialData={initialData} filters={filters} />
      </main>
    </div>
  )
}
