"use client"

import { useRef, useState } from "react"
import { toast } from "sonner"
import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import {
  useCreateFeatureFlag,
  useDeleteFeatureFlag,
  useFeatureFlags,
  useFlagOverrides,
  useRemoveFlagOverride,
  useSetFeatureFlag,
  useSetFlagOverride,
} from "@sendcms/platform-ops/queries"
import { useAdminUsers } from "@sendcms/admin-users/queries"
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
  Switch,
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

/** A flag key is the stable machine name: lowercase letters, digits
    and hyphens, never starting with a hyphen (the service's
    FlagKeySchema, mirrored here for inline validation). */
const FLAG_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/** The built-in system flags — mirrors SYSTEM_FLAGS in
    packages/modules/platform-ops/src/flags.ts (kept as a client-side
    copy because the service module pulls @sendcms/database into the
    browser bundle if imported here). Deleting one would silently
    disable its live job, so the service refuses with a 422 and the
    UI shows a Built-in badge instead of a delete button. The
    wave5-stream-c locale test asserts the two lists still match. */
const SYSTEM_FLAG_KEYS = ["ai-spam-rescore", "ai-digest"] as const

function isSystemFlag(key: string): boolean {
  return (SYSTEM_FLAG_KEYS as readonly string[]).includes(key)
}

/**
 * The feature flags page (Phase 7): the flags table, the create
 * dialog, the global toggle (reason dialog — the service requires a
 * reason), and the per-user overrides manager. Two features read
 * flags (ai-spam-rescore, ai-digest); an unknown or disabled flag
 * keeps its job off. Built-in system flags cannot be deleted (the
 * service refuses with a 422 — deleting one would silently disable
 * its live job), so the delete button is shown only for other flags.
 * The flags page is a management page (owner + SUPER_ADMIN only), so
 * an actor without MANAGE_FEATURE_FLAGS gets the no-permission card
 * and the list query never fires.
 */
export function FeaturesOverview({ actorRole }: Props) {
  const { t } = useTranslation("features")
  const canManage = adminCan(actorRole, "MANAGE_FEATURE_FLAGS")

  if (!canManage) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm text-muted-foreground">{t("noPermission")}</p>
        </CardContent>
      </Card>
    )
  }

  return <FeaturesInner />
}

function FeaturesInner() {
  const { t } = useTranslation("features")
  const { data, isLoading } = useFeatureFlags()
  const createFlag = useCreateFeatureFlag()

  // Create dialog state.
  const [createOpen, setCreateOpen] = useState(false)
  const [newKey, setNewKey] = useState("")
  const [newName, setNewName] = useState("")
  const [newDescription, setNewDescription] = useState("")
  const [keyError, setKeyError] = useState(false)

  // The pending global toggle: null = no dialog open.
  const [pendingToggle, setPendingToggle] = useState<{
    key: string
    isEnabled: boolean
  } | null>(null)
  const [toggleReason, setToggleReason] = useState("")
  // The toggle mutation is only invoked from the confirm handler,
  // when pendingToggle is set — so the key is correct at call time.
  const setFlag = useSetFeatureFlag(pendingToggle?.key ?? "")

  // The pending delete: null = no dialog open.
  const [pendingDelete, setPendingDelete] = useState<{
    key: string
    name: string
  } | null>(null)
  const [deleteReason, setDeleteReason] = useState("")
  // Same shape as the toggle mutation above.
  const deleteFlag = useDeleteFeatureFlag(pendingDelete?.key ?? "")

  // Which flag's overrides are open below the table.
  const [overridesFlagKey, setOverridesFlagKey] = useState<string | null>(null)

  const flags = data?.flags ?? []

  function openCreate() {
    setNewKey("")
    setNewName("")
    setNewDescription("")
    setKeyError(false)
    setCreateOpen(true)
  }

  async function confirmCreate() {
    if (!FLAG_KEY_PATTERN.test(newKey.trim()) || newName.trim() === "") {
      setKeyError(true)
      return
    }
    try {
      await createFlag.mutateAsync({
        key: newKey.trim(),
        name: newName.trim(),
        description: newDescription.trim() || undefined,
      })
      toast.success(t("flagCreated"))
      setCreateOpen(false)
    } catch {
      // The query provider's global mutation error toast already
      // shows the failure — the dialog stays open to retry.
    }
  }

  async function confirmToggle() {
    if (!pendingToggle) return
    try {
      await setFlag.mutateAsync({
        isEnabled: pendingToggle.isEnabled,
        reason: toggleReason.trim(),
      })
      toast.success(t("flagSaved"))
      setPendingToggle(null)
      setToggleReason("")
    } catch {
      // The global mutation error toast already shows the failure.
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    try {
      await deleteFlag.mutateAsync({ reason: deleteReason.trim() })
      toast.success(t("flagDeleted"))
      setPendingDelete(null)
      setDeleteReason("")
    } catch {
      // The global mutation error toast already shows the failure.
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">{t("phase8Note")}</p>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>{t("title")}</CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </div>
          <Button onClick={openCreate}>{t("createFlag")}</Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : flags.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t("noFlags")}
            </p>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("colKey")}</TableHead>
                    <TableHead>{t("colName")}</TableHead>
                    <TableHead>{t("colStatus")}</TableHead>
                    <TableHead>{t("colOverrides")}</TableHead>
                    <TableHead>{t("colActions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {flags.map((flag) => (
                    <TableRow key={flag.key}>
                      <TableCell className="font-mono text-sm font-medium">
                        {flag.key}
                      </TableCell>
                      <TableCell>
                        <p className="font-medium">{flag.name}</p>
                        {flag.description && (
                          <p className="text-sm text-muted-foreground">
                            {flag.description}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={flag.isEnabled ? "secondary" : "outline"}
                        >
                          {flag.isEnabled ? t("enabled") : t("disabled")}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <FlagOverrideCount flagKey={flag.key} />
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={flag.isEnabled}
                              onCheckedChange={() => {
                                setToggleReason("")
                                setPendingToggle({
                                  key: flag.key,
                                  isEnabled: !flag.isEnabled,
                                })
                              }}
                              aria-label={t("toggleTitle")}
                            />
                            <span className="text-sm font-medium">
                              {flag.isEnabled ? t("enabled") : t("disabled")}
                            </span>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              setOverridesFlagKey(
                                overridesFlagKey === flag.key ? null : flag.key
                              )
                            }
                          >
                            {t("manageOverrides")}
                          </Button>
                          {isSystemFlag(flag.key) ? (
                            <Badge variant="outline">{t("systemFlag")}</Badge>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setDeleteReason("")
                                setPendingDelete({
                                  key: flag.key,
                                  name: flag.name,
                                })
                              }}
                            >
                              {t("deleteFlag")}
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {overridesFlagKey && (
        <FlagOverridesPanel
          flagKey={overridesFlagKey}
          onClose={() => setOverridesFlagKey(null)}
        />
      )}

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open) setCreateOpen(false)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("createTitle")}</DialogTitle>
            <DialogDescription>{t("createDescription")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="space-y-1">
              <Label htmlFor="flag-key">{t("flagKey")}</Label>
              <Input
                id="flag-key"
                value={newKey}
                onChange={(e) => {
                  setNewKey(e.target.value)
                  setKeyError(false)
                }}
                placeholder={t("flagKeyPlaceholder")}
                maxLength={100}
              />
              {keyError && (
                <p className="text-sm text-destructive">
                  {t("createDescription")}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label htmlFor="flag-name">{t("flagName")}</Label>
              <Input
                id="flag-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t("flagNamePlaceholder")}
                maxLength={200}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="flag-description">{t("flagDescription")}</Label>
              <Textarea
                id="flag-description"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder={t("flagDescriptionPlaceholder")}
                maxLength={500}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              onClick={confirmCreate}
              disabled={
                createFlag.isPending ||
                newKey.trim() === "" ||
                newName.trim() === ""
              }
            >
              {t("create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingToggle !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingToggle(null)
            setToggleReason("")
          }
        }}
      >
        <DialogContent>
          {pendingToggle !== null && (
            <>
              <DialogHeader>
                <DialogTitle>{t("toggleTitle")}</DialogTitle>
                <DialogDescription>
                  {pendingToggle.isEnabled
                    ? t("toggleEnableDescription")
                    : t("toggleDisableDescription")}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-1">
                <Label htmlFor="flag-toggle-reason">{t("reasonLabel")}</Label>
                <Textarea
                  id="flag-toggle-reason"
                  value={toggleReason}
                  onChange={(e) => setToggleReason(e.target.value)}
                  placeholder={t("reasonPlaceholder")}
                  maxLength={500}
                  rows={3}
                />
                {toggleReason.trim() === "" && (
                  <p className="text-sm text-destructive">
                    {t("reasonRequired")}
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setPendingToggle(null)
                    setToggleReason("")
                  }}
                >
                  {t("cancel")}
                </Button>
                <Button
                  variant={pendingToggle.isEnabled ? "default" : "destructive"}
                  onClick={confirmToggle}
                  disabled={setFlag.isPending || toggleReason.trim() === ""}
                >
                  {t("save")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDelete(null)
            setDeleteReason("")
          }
        }}
      >
        <DialogContent>
          {pendingDelete !== null && (
            <>
              <DialogHeader>
                <DialogTitle>{t("deleteTitle")}</DialogTitle>
                <DialogDescription>{t("deleteDescription")}</DialogDescription>
              </DialogHeader>
              <div className="space-y-1">
                <Label htmlFor="flag-delete-reason">{t("reasonLabel")}</Label>
                <Textarea
                  id="flag-delete-reason"
                  value={deleteReason}
                  onChange={(e) => setDeleteReason(e.target.value)}
                  placeholder={t("reasonPlaceholder")}
                  maxLength={500}
                  rows={3}
                />
                {deleteReason.trim() === "" && (
                  <p className="text-sm text-destructive">
                    {t("reasonRequired")}
                  </p>
                )}
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setPendingDelete(null)
                    setDeleteReason("")
                  }}
                >
                  {t("cancel")}
                </Button>
                <Button
                  variant="destructive"
                  onClick={confirmDelete}
                  disabled={deleteFlag.isPending || deleteReason.trim() === ""}
                >
                  {t("deleteFlag")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** The per-user override count for one flag (its own query, cached
    under the same key the overrides panel reads). */
function FlagOverrideCount({ flagKey }: { flagKey: string }) {
  const { data, isLoading } = useFlagOverrides(flagKey)
  if (isLoading) return <Skeleton className="h-5 w-8" />
  return <span>{data?.overrides.length ?? 0}</span>
}

/** The per-user overrides manager for one flag: the existing
    overrides, and the add form (user search + state + reason). */
function FlagOverridesPanel({
  flagKey,
  onClose,
}: {
  flagKey: string
  onClose: () => void
}) {
  const { t } = useTranslation("features")
  const { data, isLoading } = useFlagOverrides(flagKey)
  const removeOverride = useRemoveFlagOverride(flagKey)

  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [selectedUserId, setSelectedUserId] = useState("")
  const [overrideEnabled, setOverrideEnabled] = useState(true)
  const [overrideReason, setOverrideReason] = useState("")
  const setOverride = useSetFlagOverride(flagKey, selectedUserId)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { data: usersData } = useAdminUsers({
    q: debouncedSearch || undefined,
    page: 1,
    perPage: 10,
    sort: "createdAt:desc",
  })
  const users = usersData?.users ?? []
  const overrides = data?.overrides ?? []

  function onSearchChange(value: string) {
    setSearch(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedSearch(value), 300)
  }

  async function confirmSetOverride() {
    if (!selectedUserId || overrideReason.trim() === "") return
    try {
      await setOverride.mutateAsync({
        isEnabled: overrideEnabled,
        reason: overrideReason.trim(),
      })
      toast.success(t("overrideSaved"))
      setSelectedUserId("")
      setOverrideReason("")
      setSearch("")
      setDebouncedSearch("")
    } catch {
      // The global mutation error toast already shows the failure.
    }
  }

  async function confirmRemoveOverride(userId: string) {
    try {
      await removeOverride.mutateAsync(userId)
      toast.success(t("overrideRemoved"))
    } catch {
      // The global mutation error toast already shows the failure.
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>{t("overridesFor", { key: flagKey })}</CardTitle>
          <CardDescription>{t("overridesDescription")}</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={onClose}>
          {t("cancel")}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : overrides.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t("overrideNone")}
          </p>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colUser")}</TableHead>
                  <TableHead>{t("colState")}</TableHead>
                  <TableHead>{t("colReason")}</TableHead>
                  <TableHead>{t("colActions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overrides.map((override) => (
                  <TableRow key={override.userId}>
                    <TableCell className="font-medium">
                      {override.user?.name ??
                        override.user?.email ??
                        override.userId}
                      {override.user?.email && override.user?.name && (
                        <p className="text-sm font-normal text-muted-foreground">
                          {override.user.email}
                        </p>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={override.isEnabled ? "secondary" : "outline"}
                      >
                        {override.isEnabled
                          ? t("overrideEnable")
                          : t("overrideDisable")}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-64 truncate">
                      {override.reason}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => confirmRemoveOverride(override.userId)}
                        disabled={removeOverride.isPending}
                      >
                        {t("remove")}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <div className="flex flex-col gap-4 rounded-lg border p-4">
          <p className="text-sm font-medium">{t("overridesTitle")}</p>
          <div className="space-y-1">
            <Label htmlFor="override-user-search">
              {t("overrideUserLabel")}
            </Label>
            <Input
              id="override-user-search"
              value={search}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={t("overrideSearchPlaceholder")}
            />
            {users.length > 0 && (
              <Select value={selectedUserId} onValueChange={setSelectedUserId}>
                <SelectTrigger>
                  <SelectValue placeholder={t("selectUser")} />
                </SelectTrigger>
                <SelectContent>
                  {users.map((user) => (
                    <SelectItem key={user.id} value={user.id}>
                      {user.name ?? user.email} · {user.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="flex items-center gap-3">
            <Switch
              checked={overrideEnabled}
              onCheckedChange={setOverrideEnabled}
              aria-label={t("overrideState")}
            />
            <span className="text-sm font-medium">
              {overrideEnabled ? t("overrideEnable") : t("overrideDisable")}
            </span>
          </div>
          <div className="space-y-1">
            <Label htmlFor="override-reason">{t("reasonLabel")}</Label>
            <Textarea
              id="override-reason"
              value={overrideReason}
              onChange={(e) => setOverrideReason(e.target.value)}
              placeholder={t("reasonPlaceholder")}
              maxLength={500}
              rows={2}
            />
            {overrideReason.trim() === "" && (
              <p className="text-sm text-destructive">{t("reasonRequired")}</p>
            )}
          </div>
          <div>
            <Button
              onClick={confirmSetOverride}
              disabled={
                setOverride.isPending ||
                selectedUserId === "" ||
                overrideReason.trim() === ""
              }
            >
              {t("save")}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
