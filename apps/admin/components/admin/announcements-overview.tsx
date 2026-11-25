"use client"

import { useState } from "react"
import { toast } from "sonner"
import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import type { AnnouncementRow } from "@sendcms/platform-ops"
import {
  useAnnouncements,
  useCreateAnnouncement,
  useSetAnnouncementActive,
  useUpdateAnnouncement,
} from "@sendcms/platform-ops/queries"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
import { useTranslation } from "@/components/admin/translation-provider"

type Props = {
  actorRole: PlatformRole | AdminRole
}

/** Convert an ISO date to a datetime-local input value. */
function toDatetimeLocal(value: string | Date | null): string {
  if (!value) return ""
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatDate(value: string | Date | null) {
  if (!value) return "—"
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * The announcements page (Phase 7): the announcements table, the
 * create/edit dialog, and the publish/deactivate switch (reason
 * dialog — the service requires a reason). Announcements are never
 * deleted: deactivation is the way to take one down. The page is a
 * management page (owner + SUPER_ADMIN only), so an actor without
 * MANAGE_ANNOUNCEMENTS gets the no-permission card and the list
 * query never fires.
 */
export function AnnouncementsOverview({ actorRole }: Props) {
  const { t } = useTranslation("announcements")
  const canManage = adminCan(actorRole, "MANAGE_ANNOUNCEMENTS")

  if (!canManage) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm text-muted-foreground">{t("noPermission")}</p>
        </CardContent>
      </Card>
    )
  }

  return <AnnouncementsInner />
}

function AnnouncementsInner() {
  const { t } = useTranslation("announcements")
  // ADM-093: the list API's page/perPage + isActive/audience
  // filters are threaded through the hook (audit-explorer pattern),
  // so announcements past page 1 are reachable and the list can be
  // filtered — the hook used to fetch page 1 only, with no controls.
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState<"all" | "true" | "false">(
    "all"
  )
  const [audienceFilter, setAudienceFilter] = useState<
    "all" | "ALL" | "ADMIN_ONLY"
  >("all")
  const { data, isLoading } = useAnnouncements({
    page,
    perPage: 20,
    isActive: statusFilter === "all" ? undefined : statusFilter === "true",
    audience: audienceFilter === "all" ? undefined : audienceFilter,
  })
  const createAnnouncement = useCreateAnnouncement()

  // The announcement being created (null) or edited (a row). The
  // dialog is open while this state is not undefined.
  const [editing, setEditing] = useState<AnnouncementRow | null | undefined>(
    undefined
  )
  const [formTitle, setFormTitle] = useState("")
  const [formBody, setFormBody] = useState("")
  const [formAudience, setFormAudience] = useState<"ALL" | "ADMIN_ONLY">("ALL")
  const [formStartsAt, setFormStartsAt] = useState("")
  const [formEndsAt, setFormEndsAt] = useState("")

  // The pending publish/deactivate: null = no dialog open.
  const [pendingActive, setPendingActive] = useState<{
    id: string
    isActive: boolean
  } | null>(null)
  const [activeReason, setActiveReason] = useState("")
  // The toggle mutation is only invoked from the confirm handler,
  // when pendingActive is set — so the id is correct at call time.
  const setActive = useSetAnnouncementActive(pendingActive?.id ?? "")
  const updateAnnouncement = useUpdateAnnouncement(editing?.id ?? "")

  const announcements = data?.announcements ?? []
  const totalPages = data?.totalPages ?? 1
  const currentPage = data?.page ?? page

  function changeStatusFilter(value: "all" | "true" | "false") {
    setStatusFilter(value)
    setPage(1)
  }

  function changeAudienceFilter(value: "all" | "ALL" | "ADMIN_ONLY") {
    setAudienceFilter(value)
    setPage(1)
  }

  function openCreate() {
    setFormTitle("")
    setFormBody("")
    setFormAudience("ALL")
    setFormStartsAt("")
    setFormEndsAt("")
    setEditing(null)
  }

  function openEdit(row: AnnouncementRow) {
    setFormTitle(row.title)
    setFormBody(row.body)
    setFormAudience(row.audience)
    setFormStartsAt(toDatetimeLocal(row.startsAt))
    setFormEndsAt(toDatetimeLocal(row.endsAt))
    setEditing(row)
  }

  async function confirmSave() {
    if (formTitle.trim() === "" || formBody.trim() === "") return
    try {
      if (editing === null) {
        await createAnnouncement.mutateAsync({
          title: formTitle.trim(),
          body: formBody.trim(),
          audience: formAudience,
          startsAt: formStartsAt || undefined,
          endsAt: formEndsAt || undefined,
        })
      } else if (editing) {
        // A cleared window bound sends null (the service clears it);
        // an untouched bound is omitted.
        await updateAnnouncement.mutateAsync({
          title: formTitle.trim(),
          body: formBody.trim(),
          audience: formAudience,
          startsAt:
            formStartsAt === ""
              ? editing.startsAt
                ? null
                : undefined
              : formStartsAt,
          endsAt:
            formEndsAt === ""
              ? editing.endsAt
                ? null
                : undefined
              : formEndsAt,
        })
      }
      toast.success(t("saved"))
      setEditing(undefined)
    } catch {
      // The global mutation error toast already shows the failure.
    }
  }

  async function confirmActive() {
    if (!pendingActive) return
    try {
      await setActive.mutateAsync({
        isActive: pendingActive.isActive,
        reason: activeReason.trim(),
      })
      toast.success(t("saved"))
      setPendingActive(null)
      setActiveReason("")
    } catch {
      // The global mutation error toast already shows the failure.
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>{t("title")}</CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </div>
          <Button onClick={openCreate}>{t("createAnnouncement")}</Button>
        </CardHeader>
        <CardContent>
          <div className="mb-4 flex flex-wrap items-end gap-4">
            <div className="space-y-1">
              <Label htmlFor="announcement-status-filter">
                {t("filterStatus")}
              </Label>
              <Select
                value={statusFilter}
                onValueChange={(v) =>
                  changeStatusFilter(v as "all" | "true" | "false")
                }
              >
                <SelectTrigger id="announcement-status-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("all")}</SelectItem>
                  <SelectItem value="true">{t("active")}</SelectItem>
                  <SelectItem value="false">{t("inactive")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="announcement-audience-filter">
                {t("filterAudience")}
              </Label>
              <Select
                value={audienceFilter}
                onValueChange={(v) =>
                  changeAudienceFilter(v as "all" | "ALL" | "ADMIN_ONLY")
                }
              >
                <SelectTrigger id="announcement-audience-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("all")}</SelectItem>
                  <SelectItem value="ALL">{t("audienceAll")}</SelectItem>
                  <SelectItem value="ADMIN_ONLY">
                    {t("audienceAdminOnly")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : announcements.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t("noAnnouncements")}
            </p>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("colTitle")}</TableHead>
                    <TableHead>{t("colAudience")}</TableHead>
                    <TableHead>{t("colStatus")}</TableHead>
                    <TableHead>{t("colWindow")}</TableHead>
                    <TableHead>{t("colCreatedBy")}</TableHead>
                    <TableHead>{t("colActions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {announcements.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="max-w-64">
                        <p className="font-medium">{row.title}</p>
                        <p className="truncate text-sm text-muted-foreground">
                          {row.body}
                        </p>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {row.audience === "ALL"
                            ? t("audienceAll")
                            : t("audienceAdminOnly")}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={row.isActive ? "secondary" : "outline"}>
                          {row.isActive ? t("active") : t("inactive")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {row.startsAt || row.endsAt ? (
                          <>
                            {formatDate(row.startsAt)}
                            {" — "}
                            {formatDate(row.endsAt)}
                          </>
                        ) : (
                          t("windowAlways")
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {row.createdBy?.name ?? row.createdBy?.email ?? "—"}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openEdit(row)}
                          >
                            {t("edit")}
                          </Button>
                          <Button
                            variant={row.isActive ? "outline" : "default"}
                            size="sm"
                            onClick={() => {
                              setActiveReason("")
                              setPendingActive({
                                id: row.id,
                                isActive: !row.isActive,
                              })
                            }}
                          >
                            {row.isActive ? t("deactivate") : t("publish")}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <div className="mt-4 flex items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">
              {t("pageOf", { page: currentPage, totalPages })}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={currentPage <= 1}
              >
                {t("prev")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => p + 1)}
                disabled={currentPage >= totalPages}
              >
                {t("next")}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={editing !== undefined}
        onOpenChange={(open) => {
          if (!open) setEditing(undefined)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing === null
                ? t("createAnnouncement")
                : t("editAnnouncement")}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="space-y-1">
              <Label htmlFor="announcement-title">
                {t("announcementTitle")}
              </Label>
              <Input
                id="announcement-title"
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                placeholder={t("announcementTitlePlaceholder")}
                maxLength={200}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="announcement-body">{t("body")}</Label>
              <Textarea
                id="announcement-body"
                value={formBody}
                onChange={(e) => setFormBody(e.target.value)}
                placeholder={t("bodyPlaceholder")}
                maxLength={2000}
                rows={4}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="announcement-audience">{t("audience")}</Label>
              <Select
                value={formAudience}
                onValueChange={(v) =>
                  setFormAudience(v as "ALL" | "ADMIN_ONLY")
                }
              >
                <SelectTrigger id="announcement-audience">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">{t("audienceAll")}</SelectItem>
                  <SelectItem value="ADMIN_ONLY">
                    {t("audienceAdminOnly")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="announcement-starts-at">{t("startsAt")}</Label>
                <Input
                  id="announcement-starts-at"
                  type="datetime-local"
                  value={formStartsAt}
                  onChange={(e) => setFormStartsAt(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="announcement-ends-at">{t("endsAt")}</Label>
                <Input
                  id="announcement-ends-at"
                  type="datetime-local"
                  value={formEndsAt}
                  onChange={(e) => setFormEndsAt(e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(undefined)}>
              {t("cancel")}
            </Button>
            <Button
              onClick={confirmSave}
              disabled={
                createAnnouncement.isPending ||
                updateAnnouncement.isPending ||
                formTitle.trim() === "" ||
                formBody.trim() === ""
              }
            >
              {editing === null ? t("create") : t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingActive !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingActive(null)
            setActiveReason("")
          }
        }}
      >
        <DialogContent>
          {pendingActive !== null && (
            <>
              <DialogHeader>
                <DialogTitle>
                  {pendingActive.isActive
                    ? t("activateTitle")
                    : t("deactivateTitle")}
                </DialogTitle>
                <DialogDescription>
                  {pendingActive.isActive
                    ? t("activateDescription")
                    : t("deactivateDescription")}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-1">
                <Label htmlFor="announcement-active-reason">
                  {t("reasonLabel")}
                </Label>
                <Textarea
                  id="announcement-active-reason"
                  value={activeReason}
                  onChange={(e) => setActiveReason(e.target.value)}
                  placeholder={t("reasonPlaceholder")}
                  maxLength={500}
                  rows={3}
                />
                {activeReason.trim() === "" && (
                  <p className="text-sm text-destructive">
                    {t("reasonRequired")}
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setPendingActive(null)
                    setActiveReason("")
                  }}
                >
                  {t("cancel")}
                </Button>
                <Button
                  variant={pendingActive.isActive ? "default" : "destructive"}
                  onClick={confirmActive}
                  disabled={setActive.isPending || activeReason.trim() === ""}
                >
                  {pendingActive.isActive ? t("publish") : t("deactivate")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
