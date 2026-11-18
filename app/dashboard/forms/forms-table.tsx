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
  const { data: forms = initialForms } = useForms(initialForms)

  if (forms.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-20 text-center">
        <RiInboxLine
          className="mb-4 size-10 text-muted-foreground"
          aria-hidden="true"
        />
        <h3 className="mb-1 text-lg font-semibold text-balance">
          No forms yet
        </h3>
        <p className="mb-4 max-w-sm text-sm text-muted-foreground">
          Create your first form to start collecting submissions from your
          sites. Every form starts with name, email and message fields.
        </p>
        <Button asChild size="sm">
          <Link href="/dashboard/forms/new">
            <RiAddLine className="size-4" aria-hidden="true" />
            New form
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
            <TableHead>Form</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Fields</TableHead>
            <TableHead>Domains</TableHead>
            <TableHead>Submissions</TableHead>
            <TableHead>Created</TableHead>
            <TableHead className="w-20" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {forms.map((form) => (
            <TableRow key={form.id}>
              <TableCell className="font-medium">{form.name}</TableCell>
              <TableCell>
                <Badge variant={form.active ? "default" : "secondary"}>
                  {form.active ? "Active" : "Paused"}
                </Badge>
              </TableCell>
              <TableCell>{form._count.fields}</TableCell>
              <TableCell>{form._count.domainLinks}</TableCell>
              <TableCell>{form._count.submissions}</TableCell>
              <TableCell>{formatDate(form.createdAt)}</TableCell>
              <TableCell>
                <Button asChild variant="ghost" size="sm">
                  <Link href={`/dashboard/forms/${form.id}`}>Open</Link>
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
