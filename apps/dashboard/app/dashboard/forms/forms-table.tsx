"use client"

import Link from "next/link"
import { useForms } from "@sendcms/forms/queries"
import type { FormWithCounts } from "@sendcms/forms/queries"

import {
  Badge,
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@sendcms/ui"

import { RiAddLine, RiInboxLine } from "@remixicon/react"
import { useTranslation } from "@/components/dashboard/translation-provider"

function formatDate(value: string | Date | null) {
  if (!value) return "—"
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

export function FormsTable({
  initialForms,
}: {
  initialForms: FormWithCounts[]
}) {
  const { t } = useTranslation("forms")
  const { data: forms = initialForms } = useForms(initialForms)

  if (forms.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-20 text-center">
        <RiInboxLine
          className="mb-4 size-10 text-muted-foreground"
          aria-hidden="true"
        />
        <h3 className="mb-1 text-lg font-semibold text-balance">
          {t("emptyTitle")}
        </h3>
        <p className="mb-4 max-w-sm text-sm text-muted-foreground">
          {t("emptyDescription")}
        </p>
        <Button asChild size="sm">
          <Link href="/dashboard/forms/new">
            <RiAddLine className="size-4" aria-hidden="true" />
            {t("newForm")}
          </Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("colForm")}</TableHead>
            <TableHead>{t("colStatus")}</TableHead>
            <TableHead>{t("colFields")}</TableHead>
            <TableHead>{t("colDomains")}</TableHead>
            <TableHead>{t("colSubmissions")}</TableHead>
            <TableHead>{t("colCreated")}</TableHead>
            <TableHead className="w-20" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {forms.map((form) => (
            <TableRow key={form.id}>
              <TableCell className="font-medium">{form.name}</TableCell>
              <TableCell>
                <Badge variant={form.active ? "default" : "secondary"}>
                  {form.active ? t("statusActive") : t("statusPaused")}
                </Badge>
              </TableCell>
              <TableCell>{form._count.fields}</TableCell>
              <TableCell>{form._count.domainLinks}</TableCell>
              <TableCell>{form._count.submissions}</TableCell>
              <TableCell>{formatDate(form.createdAt)}</TableCell>
              <TableCell>
                <Button asChild variant="ghost" size="sm">
                  <Link href={`/dashboard/forms/${form.id}`}>{t("open")}</Link>
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
