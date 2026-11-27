// User-detail "Forms" tab (Wave 10, SRC-118 split of user-detail.tsx).
"use client"

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@sendcms/ui"
import { RiFileTextLine } from "@remixicon/react"
import type { AdminUserDetail } from "@sendcms/admin-users/queries"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatDate } from "../plan-format"
import { EmptyState } from "./shared"

export function UserFormsTab({ forms }: { forms: AdminUserDetail["forms"] }) {
  const { t } = useTranslation("users")
  const locale = useLocale()

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">{t("formsTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        {forms.length === 0 ? (
          <EmptyState
            icon={
              <RiFileTextLine
                className="mb-4 size-10 text-muted-foreground"
                aria-hidden="true"
              />
            }
            title={t("formsEmptyTitle")}
            description={t("formsEmptyDescription")}
          />
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("formName")}</TableHead>
                  <TableHead>{t("formAi")}</TableHead>
                  <TableHead>{t("formCreated")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {forms.map((form) => (
                  <TableRow key={form.id}>
                    <TableCell className="font-medium">{form.name}</TableCell>
                    <TableCell>
                      {form.aiEnabled ? t("aiYes") : t("aiNo")}
                    </TableCell>
                    <TableCell>{formatDate(locale, form.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
