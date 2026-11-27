"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import { useMcpKeys, useRevokeMcpKey } from "@sendcms/mcp-admin/queries"
import type { McpKeysFilters } from "@sendcms/mcp-admin"
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
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@sendcms/ui"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatDate } from "./plan-format"
import { StepUpDialog } from "./step-up-dialog"

type Props = {
  actorRole: PlatformRole | AdminRole
  initialFilters: McpKeysFilters & { page: number; perPage: number }
}

/**
 * The MCP keys page (Phase 6): every API key with its owner, scope,
 * last use, and its calls in the last 30 days — plus revoke, which
 * needs MANAGE_MCP and a reason (the service requires one, and the
 * revoke is audited). Key material never appears here: the list
 * selects metadata only, and only the prefix + last 4 are shown.
 */
export function McpKeysTable({ actorRole, initialFilters }: Props) {
  const { t } = useTranslation("mcp")
  const locale = useLocale()
  const canViewMcp = adminCan(actorRole, "VIEW_MCP")
  const canManageMcp = adminCan(actorRole, "MANAGE_MCP")
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [page, setPage] = useState(initialFilters.page)
  // ADM-064: search + revoked/active + scope filters, server-side.
  const [search, setSearch] = useState(initialFilters.search ?? "")
  const [scope, setScope] = useState<string>(initialFilters.scope ?? "all")
  const [revoked, setRevoked] = useState<string>(
    initialFilters.revoked === undefined
      ? "all"
      : initialFilters.revoked
        ? "revoked"
        : "active"
  )
  const { data, isLoading, isError, refetch } = useMcpKeys(page, 20, {
    search: search || undefined,
    scope: scope === "all" ? undefined : (scope as "READ" | "FULL"),
    revoked: revoked === "all" ? undefined : revoked === "revoked",
  })

  // ADM-066: filters + pagination live in the URL, following the
  // users table. Changing a filter resets to page 1.
  function pushParams(next: URLSearchParams) {
    const text = next.toString()
    router.push(text ? `${pathname}?${text}` : pathname)
  }

  function applyFilter(key: string, value: string | null) {
    const next = new URLSearchParams(searchParams.toString())
    if (value === null || value === "" || value === "all") {
      next.delete(key)
    } else {
      next.set(key, value)
    }
    next.delete("page")
    pushParams(next)
  }

  function applyPage(nextPage: number) {
    const next = new URLSearchParams(searchParams.toString())
    next.set("page", String(nextPage))
    pushParams(next)
  }
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
        {/* UX-011: section heading for the outline — see plans-table. */}
        <h2 className="sr-only">{t("keysTitle")}</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="mcp-keys-search">{t("searchKeys")}</Label>
            <Input
              id="mcp-keys-search"
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value)
                setPage(1)
                applyFilter("search", e.target.value)
              }}
              placeholder={t("searchKeysPlaceholder")}
              className="h-9 w-64"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="mcp-keys-scope">{t("filterScope")}</Label>
            <Select
              value={scope}
              onValueChange={(v) => {
                setScope(v)
                setPage(1)
                applyFilter("scope", v)
              }}
            >
              <SelectTrigger id="mcp-keys-scope" className="h-9 w-36">
                <SelectValue placeholder={t("allScopes")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("allScopes")}</SelectItem>
                <SelectItem value="READ">READ</SelectItem>
                <SelectItem value="FULL">FULL</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="mcp-keys-status">{t("filterStatus")}</Label>
            <Select
              value={revoked}
              onValueChange={(v) => {
                setRevoked(v)
                setPage(1)
                applyFilter(
                  "revoked",
                  v === "all" ? null : v === "revoked" ? "true" : "false"
                )
              }}
            >
              <SelectTrigger id="mcp-keys-status" className="h-9 w-36">
                <SelectValue placeholder={t("allStatuses")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("allStatuses")}</SelectItem>
                <SelectItem value="active">{t("statusActive")}</SelectItem>
                <SelectItem value="revoked">{t("statusRevoked")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : isError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm"
          >
            <span>{t("loadError")}</span>
            <Button variant="outline" size="sm" onClick={() => void refetch()}>
              {t("retry")}
            </Button>
          </div>
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
                          href={`/admin/all-users/${key.userId}`}
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
                    <TableCell>{formatDate(locale, key.lastUsedAt)}</TableCell>
                    <TableCell>{formatDate(locale, key.createdAt)}</TableCell>
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
              onClick={() => {
                setPage(currentPage - 1)
                applyPage(currentPage - 1)
              }}
            >
              {t("prevPage")}
            </Button>
            <Button
              variant="outline"
              disabled={currentPage >= totalPages}
              onClick={() => {
                setPage(currentPage + 1)
                applyPage(currentPage + 1)
              }}
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
