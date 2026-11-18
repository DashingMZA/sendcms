import Link from "next/link"
import { auth } from "@/lib/auth"
import { listFormsForUser } from "@/lib/services/form-service"
import { PageHeader } from "@/components/dashboard/page-header"
import { InstallSnippet } from "@/components/dashboard/install-snippet"
import { CopyField } from "../domains/copy-field"
import { Separator } from "@sendcms/ui"

import {
  buildFormExample,
  buildRestExample,
  buildSdkScriptTag,
} from "@/lib/sdk-snippet"

export default async function ApiPage() {
  const session = await auth()
  const userId = session!.user!.id as string
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"
  const forms = await listFormsForUser(userId)

  return (
    <div>
      <PageHeader
        title="API & SDK"
        description="Connect any site to SendCMS — one script tag, or the REST API directly"
      />

      <div className="flex max-w-3xl flex-col gap-8 p-8">
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
            Your public user id
          </h2>
          <Separator />
          <CopyField
            label="userId"
            value={userId}
            description="Public — it goes in your site's code alongside each form's id. It identifies your account, not a secret."
          />
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
            1. JavaScript SDK
          </h2>
          <Separator />
          <p className="text-sm text-muted-foreground">
            Add the script tag to any page, then mark a form with{" "}
            <code className="rounded bg-muted px-1 font-mono text-xs">
              data-cms-form
            </code>{" "}
            and its form id. The SDK enhances the form in place: loading,
            success and error states, duplicate prevention and spam protection
            are built in. Full reference:{" "}
            <code className="rounded bg-muted px-1 font-mono text-xs">
              docs/sdk.md
            </code>{" "}
            in the repository.
          </p>
          <InstallSnippet code={buildSdkScriptTag(appUrl, userId)} />
          <InstallSnippet code={buildFormExample(appUrl, userId)} />
          <p className="text-sm text-muted-foreground">
            Each form&apos;s id is on its detail page, with a ready-made
            snippet:{" "}
            {forms.length === 0 ? (
              <>
                create a form first —{" "}
                <Link
                  href="/dashboard/forms/new"
                  className="font-medium text-primary underline-offset-4 hover:underline"
                >
                  new form
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
            2. REST API
          </h2>
          <Separator />
          <p className="text-sm text-muted-foreground">
            Submit directly with{" "}
            <code className="rounded bg-muted px-1 font-mono text-xs">
              POST /api/public/v1/submit
            </code>
            . There are no API keys: a submission is accepted only when its{" "}
            <code className="rounded bg-muted px-1 font-mono text-xs">
              Origin
            </code>{" "}
            is a verified domain linked to the form. A plain{" "}
            <code className="rounded bg-muted px-1 font-mono text-xs">
              &lt;form&gt;
            </code>{" "}
            post to the same URL works too, with no JavaScript — it answers with
            a redirect instead of JSON.
          </p>
          <InstallSnippet
            code={buildRestExample(appUrl, userId)}
            language="bash"
          />
          <ul className="list-disc pl-5 text-sm text-muted-foreground">
            <li>
              <code className="rounded bg-muted px-1 font-mono text-xs">
                201
              </code>{" "}
              — submission saved;{" "}
              <code className="rounded bg-muted px-1 font-mono text-xs">
                200
              </code>{" "}
              — duplicate (same idempotency key or content)
            </li>
            <li>
              <code className="rounded bg-muted px-1 font-mono text-xs">
                403
              </code>{" "}
              — origin not allowed or form inactive;{" "}
              <code className="rounded bg-muted px-1 font-mono text-xs">
                422
              </code>{" "}
              — invalid fields;{" "}
              <code className="rounded bg-muted px-1 font-mono text-xs">
                429
              </code>{" "}
              — rate or daily limit
            </li>
          </ul>
        </section>
      </div>
    </div>
  )
}
