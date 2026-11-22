"use client"

import { useState } from "react"
import Link from "next/link"
import { toast } from "sonner"
import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import { useMcpKeys, useRevokeMcpKey } from "@sendcms/mcp-admin/queries"
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@sendcms/ui"
import { useTranslation } from "@/components/admin/translation-provider"
import { formatDate } from "./plan-format"
import { StepUpDialog } from "./step-up-dialog"

type Props = {
  actorRole: PlatformRole | AdminRole
}

/**
 * The MCP keys page (Phase 6): every API key with its owner, scope,
 * last use, and its calls in the last 30 days — plus revoke, which
 * needs MANAGE_MCP and a reason (the service requires one, and the
 * revoke is audited). Key material never appears here: the list
 * selects metadata only, and only the prefix + last 4 are shown.
 */
export function McpKeysTable({ actorRole }: Props) {
  const { t } = useTranslation("mcp")
  const canViewMcp = adminCan(actorRole, "VIEW_MCP")
  const canManageMcp = adminCan(actorRole, "MANAGE_MCP")

  const [page, setPage] = useState(1)
  const { data, isLoading } = useMcpKeys(page, 20)
  const revokeKey = useRevokeMcpKey()

  const [revokeId, setRevokeId] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  // Step-up (Phase 9): the password dialog for key revoke.
  const [stepUpOpen, setStepUpOpen] = useState(false)

  if (!canViewMcp) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm text-muted-foreground">{t("noPermission")}</p>
        </CardContent>
      </Card>
    )
  }

  const keys = data?.keys ?? []
  const totalPages = data?.totalPages ?? 1
  const currentPage = data?.page ?? page
  const revokeTarget = keys.find((key) => key.id === revokeId) ?? null

  function openRevoke(keyId: string) {
    setReason("")
    setRevokeId(keyId)
  }

  async function confirmRevoke() {
    if (!revokeId) return
    try {
      await revokeKey.mutateAsync({
        keyId: revokeId,
        input: { reason: reason.trim() },
      })
      toast.success(t("revokeSuccess"))
      setRevokeId(null)
      setReason("")
    } catch {
      // The query provider's global mutation error toast already
      // shows the failure — the dialog stays open to retry.
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 pt-6">
        {isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : keys.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
            <h3 className="mb-1 text-lg font-semibold text-balance">
              {t("emptyKeys")}
            </h3>
            <p className="max-w-sm text-sm text-muted-foreground">
              {t("emptyKeysDescription")}
            </p>
          </div>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colKey")}</TableHead>
                  <TableHead>{t("colOwner")}</TableHead>
                  <TableHead>{t("colScope")}</TableHead>
                  <TableHead>{t("colLastUsed")}</TableHead>
                  <TableHead>{t("colCreated")}</TableHead>
                  <TableHead>{t("colCalls30d")}</TableHead>
                  <TableHead>{t("colStatus")}</TableHead>
                  {canManageMcp && <TableHead>{t("colActions")}</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell>
                      <p className="font-medium">{key.name}</p>
                      <p className="font-mono text-xs text-muted-foreground">
                        {key.prefix}…{key.last4}
                      </p>
                    </TableCell>
                    <TableCell>
                      {key.user ? (
                        <Link
                          href={`/admin/users/${key.userId}`}
                          className="hover:underline"
                        >
                          {key.user.name ?? key.user.email}
                        </Link>
                      ) : (
                        key.userId
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{key.scope}</Badge>
                    </TableCell>
                    <TableCell>{formatDate(key.lastUsedAt)}</TableCell>
                    <TableCell>{formatDate(key.createdAt)}</TableCell>
                    <TableCell>{key.callsLast30Days}</TableCell>
                    <TableCell>
                      {key.revokedAt ? (
                        <Badge variant="outline">{t("keyRevoked")}</Badge>
                      ) : (
                        <Badge variant="secondary">{t("keyActive")}</Badge>
                      )}
                    </TableCell>
                    {canManageMcp && (
                      <TableCell>
                        {!key.revokedAt && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => openRevoke(key.id)}
                          >
                            {t("revokeKey")}
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {t("pageOf", { page: currentPage, totalPages })}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={currentPage <= 1}
              onClick={() => setPage(currentPage - 1)}
            >
              {t("prevPage")}
            </Button>
            <Button
              variant="outline"
              disabled={currentPage >= totalPages}
              onClick={() => setPage(currentPage + 1)}
            >
              {t("nextPage")}
            </Button>
          </div>
        </div>
      </CardContent>

      <Dialog
        open={revokeId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRevokeId(null)
            setReason("")
          }
        }}
      >
        <DialogContent>
          {revokeTarget && (
            <>
              <DialogHeader>
                <DialogTitle>{t("revokeTitle")}</DialogTitle>
                <DialogDescription>
                  {revokeTarget.name} · {t("revokeDescription")}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-1">
                <Label htmlFor="mcp-revoke-reason">
                  {t("revokeReasonLabel")}
                </Label>
                <Textarea
                  id="mcp-revoke-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={t("revokeReasonPlaceholder")}
                  maxLength={500}
                  rows={3}
                />
                {reason.trim() === "" && (
                  <p className="text-sm text-destructive">
                    {t("revokeReasonRequired")}
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setRevokeId(null)
                    setReason("")
                  }}
                >
                  {t("cancel")}
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => setStepUpOpen(true)}
                  disabled={revokeKey.isPending || reason.trim() === ""}
                >
                  {t("revokeConfirm")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      <StepUpDialog
        open={stepUpOpen}
        onOpenChange={setStepUpOpen}
        onVerified={() => void confirmRevoke()}
      />
    </Card>
  )
}
