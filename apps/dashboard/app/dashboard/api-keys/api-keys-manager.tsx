"use client"

import { useState } from "react"
import {
  useApiKeys,
  useCreateApiKey,
  useRevokeApiKey,
  useRotateApiKey,
} from "@sendcms/api-keys/queries"
import type { ApiKeyPublic } from "@sendcms/api-keys/queries"
import { ApiClientError } from "@sendcms/shared"

import {
  Badge,
  Button,
  Callout,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@sendcms/ui"

import { RiKeyLine, RiMoreLine, RiRefreshLine } from "@remixicon/react"
import { CopyField } from "../domains/copy-field"
import { formatDate } from "@sendcms/i18n"
import {
  useLocale,
  useTranslation,
} from "@/components/dashboard/translation-provider"

export function ApiKeysManager({
  initialKeys,
}: {
  initialKeys: ApiKeyPublic[]
}) {
  const { t } = useTranslation("api-keys")
  const { data: keys = initialKeys } = useApiKeys(initialKeys)
  const createKey = useCreateApiKey()
  const [name, setName] = useState("")
  const [scope, setScope] = useState<"READ" | "FULL">("READ")
  const [error, setError] = useState<string | null>(null)
  // The plaintext of a just-created / just-rotated key — shown ONCE.
  // It lives only in this component's state, never in the query cache.
  const [newKey, setNewKey] = useState<string | null>(null)
  const [newKeyName, setNewKeyName] = useState<string | null>(null)

  async function onCreate(e: React.FormEvent) {
    e.preventDefault()
    // UX-110: the submit button lives in the PageHeader action slot
    // (form="create-api-key-form") — a double click while a create is
    // in flight must not create two keys.
    if (createKey.isPending) return
    setError(null)
    setNewKey(null)
    try {
      const created = await createKey.mutateAsync({ name, scope })
      setNewKey(created.key)
      setNewKeyName(created.name)
      setName("")
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t("createFailed"))
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      {newKey && (
        <Callout title={t("newKeyTitle")}>
          <CopyField
            label={newKeyName ?? t("apiKeyLabel")}
            value={newKey}
            description={t("newKeyDescription")}
            domain="api-keys"
          />
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setNewKey(null)
                setNewKeyName(null)
              }}
            >
              {t("savedIt")}
            </Button>
          </div>
        </Callout>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("createTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            id="create-api-key-form"
            onSubmit={onCreate}
            className="max-w-lg space-y-6"
          >
            <div className="space-y-2">
              <Label htmlFor="key-name">{t("nameLabel")}</Label>
              <Input
                id="key-name"
                type="text"
                autoComplete="off"
                placeholder="Claude Desktop"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={100}
              />
              <p className="text-xs text-muted-foreground">{t("nameHint")}</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="key-scope">{t("scopeLabel")}</Label>
              <Select
                value={scope}
                onValueChange={(v) => setScope(v as "READ" | "FULL")}
              >
                <SelectTrigger id="key-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="FULL">{t("scopeFull")}</SelectItem>
                  <SelectItem value="READ">{t("scopeRead")}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t("scopeHint")}</p>
            </div>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("keysTitle")}</CardTitle>
        </CardHeader>
        {keys.length === 0 ? (
          <CardContent>
            <EmptyState
              icon={RiKeyLine}
              title={t("emptyTitle")}
              description={t("emptyDescription")}
            />
          </CardContent>
        ) : (
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colName")}</TableHead>
                  <TableHead>{t("colKey")}</TableHead>
                  <TableHead>{t("colScope")}</TableHead>
                  <TableHead>{t("colLastUsed")}</TableHead>
                  <TableHead>{t("colCreated")}</TableHead>
                  <TableHead>{t("colStatus")}</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key) => (
                  <ApiKeyRow
                    key={key.id}
                    apiKey={key}
                    onNewKey={(plaintext, keyName) => {
                      setNewKey(plaintext)
                      setNewKeyName(keyName)
                    }}
                  />
                ))}
              </TableBody>
            </Table>
          </CardContent>
        )}
      </Card>
    </div>
  )
}

function ApiKeyRow({
  apiKey,
  onNewKey,
}: {
  apiKey: ApiKeyPublic
  onNewKey: (plaintext: string, keyName: string) => void
}) {
  const { t } = useTranslation("api-keys")
  const locale = useLocale()
  const revokeKey = useRevokeApiKey(apiKey.id)
  const rotateKey = useRotateApiKey(apiKey.id)
  const [error, setError] = useState<string | null>(null)
  const revoked = apiKey.revokedAt !== null

  async function onRevoke() {
    if (!window.confirm(t("confirmRevoke", { name: apiKey.name }))) return
    setError(null)
    try {
      await revokeKey.mutateAsync()
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t("revokeFailed"))
    }
  }

  async function onRotate() {
    if (!window.confirm(t("confirmRotate", { name: apiKey.name }))) return
    setError(null)
    try {
      const rotated = await rotateKey.mutateAsync()
      // The fresh key is shown once, in the box above.
      onNewKey(rotated.key, rotated.name)
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : t("rotateFailed"))
    }
  }

  return (
    <TableRow className={revoked ? "opacity-50" : undefined}>
      <TableCell className="font-medium">{apiKey.name}</TableCell>
      <TableCell className="font-mono text-xs">
        {apiKey.prefix}…{apiKey.last4}
      </TableCell>
      <TableCell>
        <Badge variant={apiKey.scope === "FULL" ? "default" : "secondary"}>
          {apiKey.scope === "FULL" ? t("scopeFullBadge") : t("scopeReadBadge")}
        </Badge>
      </TableCell>
      <TableCell>
        {apiKey.lastUsedAt
          ? formatDate(locale, apiKey.lastUsedAt, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })
          : "—"}
      </TableCell>
      <TableCell>
        {apiKey.createdAt
          ? formatDate(locale, apiKey.createdAt, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })
          : "—"}
      </TableCell>
      <TableCell>
        {revoked ? (
          <Badge variant="outline">{t("statusRevoked")}</Badge>
        ) : (
          <Badge variant="secondary">{t("statusActive")}</Badge>
        )}
      </TableCell>
      <TableCell>
        {!revoked && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="size-8 p-0">
                <RiMoreLine className="size-4" />
                <span className="sr-only">{t("actions")}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={onRotate}
                disabled={rotateKey.isPending}
              >
                <RiRefreshLine className="size-3.5" aria-hidden="true" />
                {t("rotate")}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive"
                onClick={onRevoke}
                disabled={revokeKey.isPending}
              >
                {t("revoke")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </TableCell>
    </TableRow>
  )
}
