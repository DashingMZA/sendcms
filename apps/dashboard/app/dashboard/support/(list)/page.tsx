import type { Metadata } from "next"
import Link from "next/link"
import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { listMyTickets } from "@sendcms/support"
import { MyTicketsQuerySchema } from "@sendcms/support/validators"
import { PageHeader } from "@/components/dashboard/page-header"
import { PageContent } from "@/components/dashboard/page-content"
import { Button } from "@sendcms/ui"
import {
  DASHBOARD_SUPPORT_DOMAINS,
  getDictionaries,
  getRequestLocale,
  getTranslator,
} from "@/lib/i18n"
import { TranslationProvider } from "@/components/dashboard/translation-provider"
import { SupportList } from "../support-list"

// The customer's support tickets (Phase 8). The server fetches the
// caller's own tickets and passes them as initialData; the client
// component owns the status filter and pagination through the URL.
// Page <title> follows the page locale (I18N-204): the title is the same
// key the <h1> renders, so title == heading. (SRC-113: every dashboard
// page exports metadata; the layout template appends "— SendCMS Dashboard".)
export async function generateMetadata(): Promise<Metadata> {
  const session = await auth()
  const locale = await getRequestLocale(session?.user?.id)
  const t = await getTranslator(locale, "support")
  return {
    title: t("title"),
    description: t("description"),
  }
}

export default async function SupportPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const session = await auth()
  if (!session?.user) redirect("/sign-in")

  // DSH-405: one invalid-input policy for list pages (SRC-119) — an
  // invalid query param falls back to the schema defaults, never
  // throws. `.parse()` here used to 500 on `?status=BOGUS` or
  // `?page=abc` (the error boundary), while the API underneath 422s
  // the same input correctly.
  const raw = await searchParams
  const parsed = MyTicketsQuerySchema.safeParse(raw)
  const filters = parsed.success ? parsed.data : MyTicketsQuerySchema.parse({})
  const initialData = await listMyTickets(session.user.id, filters)

  const locale = await getRequestLocale(session.user.id)
  const dictionaries = await getDictionaries(locale, DASHBOARD_SUPPORT_DOMAINS)
  const t = await getTranslator(locale, "support")

  return (
    <div>
      <PageHeader
        title={t("title")}
        description={t("description")}
        action={
          // UX-110: the page's single primary action — moved out of
          // the SupportList toolbar.
          <Button asChild>
            <Link href="/dashboard/support/new">{t("newTicket")}</Link>
          </Button>
        }
      />

      <PageContent>
        <TranslationProvider dictionaries={dictionaries}>
          <SupportList initialData={initialData} filters={filters} />
        </TranslationProvider>
      </PageContent>
    </div>
  )
}
