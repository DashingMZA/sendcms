// User-detail "MCP" tab, API-keys card (Wave 10, SRC-118 split of
// user-detail.tsx). The per-user MCP settings card itself lives in
// user-mcp-tab.tsx; this is the keys list below it.
"use client"

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@sendcms/ui"
import { RiKeyLine } from "@remixicon/react"
import type { AdminUserDetail } from "@sendcms/admin-users/queries"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatDate } from "../plan-format"
import { EmptyState } from "./shared"

type Props = {
  apiKeys: AdminUserDetail["apiKeys"]
  canManage: boolean
  onRevokeKeys: () => void
}

export function UserMcpKeysCard({ apiKeys, canManage, onRevokeKeys }: Props) {
  const { t } = useTranslation("users")
  const locale = useLocale()

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("mcpTitle")}</CardTitle>
        <CardDescription>{t("mcpNote")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {canManage && apiKeys.length > 0 && (
          <div>
            <Button variant="outline" onClick={onRevokeKeys}>
              {t("revokeAllKeys")}
            </Button>
          </div>
        )}
        {apiKeys.length === 0 ? (
          <EmptyState
            icon={
              <RiKeyLine
                className="mb-4 size-10 text-muted-foreground"
                aria-hidden="true"
              />
            }
            title={t("mcpEmptyTitle")}
            description={t("mcpEmptyDescription")}
          />
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("keyName")}</TableHead>
                  <TableHead>{t("keyValue")}</TableHead>
                  <TableHead>{t("keyScope")}</TableHead>
                  <TableHead>{t("keyLastUsed")}</TableHead>
                  <TableHead>{t("keyCreated")}</TableHead>
                  <TableHead>{t("keyRevoked")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {apiKeys.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium">{key.name}</TableCell>
                    <TableCell className="font-mono text-sm">
                      {key.prefix}…{key.last4}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{key.scope}</Badge>
                    </TableCell>
                    <TableCell>{formatDate(locale, key.lastUsedAt)}</TableCell>
                    <TableCell>{formatDate(locale, key.createdAt)}</TableCell>
                    <TableCell>
                      {key.revokedAt ? (
                        <Badge variant="outline">{t("keyRevoked")}</Badge>
                      ) : (
                        <Badge variant="secondary">{t("keyActive")}</Badge>
                      )}
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
