// User-detail "Domains" tab (Wave 10, SRC-118 split of user-detail.tsx).
"use client"

import {
  Badge,
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
import { RiInformationLine } from "@remixicon/react"
import type { AdminUserDetail } from "@sendcms/admin-users/queries"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatDate } from "../plan-format"
import { EmptyState } from "./shared"

export function UserDomainsTab({
  domains,
}: {
  domains: AdminUserDetail["domains"]
}) {
  const { t } = useTranslation("users")
  const locale = useLocale()

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("domainsTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        {domains.length === 0 ? (
          <EmptyState
            icon={
              <RiInformationLine
                className="mb-4 size-10 text-muted-foreground"
                aria-hidden="true"
              />
            }
            title={t("domainsEmptyTitle")}
            description={t("domainsEmptyDescription")}
          />
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("domainName")}</TableHead>
                  <TableHead>{t("domainStatus")}</TableHead>
                  <TableHead>{t("domainCreated")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {domains.map((domain) => (
                  <TableRow key={domain.id}>
                    <TableCell className="font-medium">
                      {domain.domain}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{domain.status}</Badge>
                    </TableCell>
                    <TableCell>
                      {formatDate(locale, domain.createdAt)}
                    </TableCell>
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
