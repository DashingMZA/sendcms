// User-detail "Audit" tab (Wave 10, SRC-118 split of user-detail.tsx):
// the audit-events card + the admin-notes card (with its add-note form).
"use client"

import { useState } from "react"
import { toast } from "sonner"
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Label,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@sendcms/ui"
import { RiInformationLine, RiStickyNoteLine } from "@remixicon/react"
import {
  useAddAdminNote,
  type AdminUserDetail,
} from "@sendcms/admin-users/queries"
import {
  useLocale,
  useTranslation,
} from "@/components/admin/translation-provider"
import { formatDateTime } from "../plan-format"
import { EmptyState } from "./shared"

type Props = {
  userId: string
  auditEvents: AdminUserDetail["auditEvents"]
  notes: AdminUserDetail["notes"]
  canManage: boolean
}

export function UserAuditTab({ userId, auditEvents, notes, canManage }: Props) {
  const { t } = useTranslation("users")
  const locale = useLocale()
  const [noteBody, setNoteBody] = useState("")
  const addNote = useAddAdminNote(userId)

  async function submitNote(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!noteBody.trim()) return
    try {
      await addNote.mutateAsync({ body: noteBody.trim() })
      setNoteBody("")
      toast.success(t("toastNoteAdded"))
    } catch {
      // Global mutation error toast already shown.
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{t("auditTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {auditEvents.length === 0 ? (
            <EmptyState
              icon={
                <RiInformationLine
                  className="mb-4 size-10 text-muted-foreground"
                  aria-hidden="true"
                />
              }
              title={t("auditEmptyTitle")}
              description={t("auditEmptyDescription")}
            />
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("auditAction")}</TableHead>
                    <TableHead>{t("auditResource")}</TableHead>
                    <TableHead>{t("auditBy")}</TableHead>
                    <TableHead>{t("auditCreated")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {auditEvents.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell>
                        <p className="font-medium">{event.action}</p>
                        <p className="max-w-64 truncate text-sm text-muted-foreground">
                          {event.detail == null
                            ? "—"
                            : JSON.stringify(event.detail)}
                        </p>
                      </TableCell>
                      <TableCell>
                        <p className="text-sm">{event.resourceType}</p>
                        <p className="font-mono text-xs text-muted-foreground">
                          {event.resourceId}
                        </p>
                      </TableCell>
                      <TableCell>
                        {event.user?.name ?? event.user?.email ?? "—"}
                      </TableCell>
                      <TableCell>
                        {formatDateTime(locale, event.createdAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("notesTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {notes.length === 0 ? (
            <EmptyState
              icon={
                <RiStickyNoteLine
                  className="mb-4 size-10 text-muted-foreground"
                  aria-hidden="true"
                />
              }
              title={t("notesEmptyTitle")}
              description={t("notesEmptyDescription")}
            />
          ) : (
            <ul className="flex flex-col gap-4">
              {notes.map((note) => (
                <li key={note.id} className="rounded-lg border p-4">
                  <p className="text-sm whitespace-pre-wrap">{note.body}</p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t("noteMeta", {
                      name: note.admin?.name ?? note.admin?.email ?? "—",
                      date: formatDateTime(locale, note.createdAt),
                    })}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {canManage && (
            <form onSubmit={submitNote} className="flex flex-col gap-2">
              <Label htmlFor="user-add-note">{t("addNoteLabel")}</Label>
              <Textarea
                id="user-add-note"
                value={noteBody}
                onChange={(e) => setNoteBody(e.target.value)}
                placeholder={t("addNotePlaceholder")}
                maxLength={2000}
                rows={3}
              />
              <div>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!noteBody.trim() || addNote.isPending}
                >
                  {t("addNoteSubmit")}
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
