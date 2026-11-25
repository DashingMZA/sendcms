import Link from "next/link"
import { requireDashboardSession } from "@/lib/require-session"
import { listFormsForUser } from "@sendcms/forms"

import { PageHeader } from "@/components/dashboard/page-header"
import { InstallSnippet } from "@/components/dashboard/install-snippet"
import { CopyField } from "../domains/copy-field"
import { Separator } from "@sendcms/ui"

import {
  buildFormExample,
  buildRestExample,
  buildSdkScriptTag,
} from "@sendcms/sdk/snippet"
import {
  DASHBOARD_API_DOMAINS,
  getDictionaries,
  getRequestLocale,
  getTranslator,
} from "@/lib/i18n"
import { TranslationProvider } from "@/components/dashboard/translation-provider"

export default async function ApiPage() {
  const session = await requireDashboardSession()
  const userId = session.user.id
  // The snippet's script src + the REST examples point at the API app
  // (the app that serves /forms/v1.js and /api/*) — not at this
  // dashboard app. See ADR 0006.
  const appUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"
  const forms = await listFormsForUser(userId)

  const locale = await getRequestLocale(userId)
  const dictionaries = await getDictionaries(locale, DASHBOARD_API_DOMAINS)
  const t = await getTranslator(locale, "api")

  return (
    <div>
      <PageHeader title={t("title")} description={t("description")} />

      <TranslationProvider dictionaries={dictionaries}>
        <div className="flex max-w-3xl flex-col gap-8 p-8">
          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
              {t("userIdTitle")}
            </h2>
            <Separator />
            <CopyField
              label="userId"
              value={userId}
              description={t("userIdDescription")}
              domain="api"
            />
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
              {t("sdkTitle")}
            </h2>
            <Separator />
            <p className="text-sm text-muted-foreground">
              {t("sdkIntro")}{" "}
              <code
                dir="ltr"
                className="rounded bg-muted px-1 font-mono text-xs"
              >
                data-cms-form
              </code>{" "}
              {t("sdkIntroMiddle")}{" "}
              <code
                dir="ltr"
                className="rounded bg-muted px-1 font-mono text-xs"
              >
                docs/sdk.md
              </code>{" "}
              {t("sdkIntroSuffix")}
            </p>
            <InstallSnippet
              code={buildSdkScriptTag(appUrl, userId)}
              domain="api"
            />
            <InstallSnippet
              code={buildFormExample(appUrl, userId)}
              domain="api"
            />
            <p className="text-sm text-muted-foreground">
              {t("sdkFormIdsIntro")}{" "}
              {forms.length === 0 ? (
                <>
                  {t("sdkFormIdsEmpty")}{" "}
                  <Link
                    href="/dashboard/forms/new"
                    className="font-medium text-primary underline-offset-4 hover:underline"
                  >
                    {t("newFormLink")}
                  </Link>
                </>
              ) : (
                forms.map((form, i) => (
                  <span key={form.id}>
                    {i > 0 && ", "}
                    <Link
                      href={`/dashboard/forms/${form.id}`}
                      className="font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {form.name}
                    </Link>
                  </span>
                ))
              )}
              .
            </p>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
              {t("restTitle")}
            </h2>
            <Separator />
            <p className="text-sm text-muted-foreground">
              {t("restIntroA")}{" "}
              <code
                dir="ltr"
                className="rounded bg-muted px-1 font-mono text-xs"
              >
                POST /api/public/v1/submit
              </code>
              {t("restIntroB")}{" "}
              <code
                dir="ltr"
                className="rounded bg-muted px-1 font-mono text-xs"
              >
                Origin
              </code>{" "}
              {t("restIntroC")}{" "}
              <code
                dir="ltr"
                className="rounded bg-muted px-1 font-mono text-xs"
              >
                &lt;form&gt;
              </code>{" "}
              {t("restIntroD")}
            </p>
            <InstallSnippet
              code={buildRestExample(appUrl, userId)}
              language="bash"
              domain="api"
            />
            <ul className="list-disc pl-5 text-sm text-muted-foreground">
              <li>
                <code
                  dir="ltr"
                  className="rounded bg-muted px-1 font-mono text-xs"
                >
                  201
                </code>{" "}
                — {t("rest201")};{" "}
                <code
                  dir="ltr"
                  className="rounded bg-muted px-1 font-mono text-xs"
                >
                  200
                </code>{" "}
                — {t("rest200")}
              </li>
              <li>
                <code
                  dir="ltr"
                  className="rounded bg-muted px-1 font-mono text-xs"
                >
                  403
                </code>{" "}
                — {t("rest403")};{" "}
                <code
                  dir="ltr"
                  className="rounded bg-muted px-1 font-mono text-xs"
                >
                  422
                </code>{" "}
                — {t("rest422")};{" "}
                <code
                  dir="ltr"
                  className="rounded bg-muted px-1 font-mono text-xs"
                >
                  429
                </code>{" "}
                — {t("rest429")}
              </li>
            </ul>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
              {t("mcpTitle")}
            </h2>
            <Separator />
            <p className="text-sm text-muted-foreground">
              {t("mcpIntroPrefix")}{" "}
              <code
                dir="ltr"
                className="rounded bg-muted px-1 font-mono text-xs"
              >
                POST /api/mcp
              </code>{" "}
              {t("mcpIntroMiddle")}{" "}
              <Link
                href="/dashboard/api-keys"
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                {t("mcpLinkText")}
              </Link>{" "}
              {t("mcpIntroSuffix")}
            </p>
          </section>
        </div>
      </TranslationProvider>
    </div>
  )
}
