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

import { RiKeyLine, RiRefreshLine } from "@remixicon/react"
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
    <div className="flex max-w-3xl flex-col gap-8">
      {newKey && (
        <section className="flex flex-col gap-3 rounded-lg border border-amber-500/50 bg-amber-500/5 p-4">
          <h2 className="text-sm font-semibold">{t("newKeyTitle")}</h2>
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
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
          {t("createTitle")}
        </h2>
        <form onSubmit={onCreate} className="max-w-lg space-y-6">
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

          <Button type="submit" disabled={createKey.isPending}>
            {createKey.isPending ? t("creating") : t("createKey")}
          </Button>
        </form>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
          {t("keysTitle")}
        </h2>
        {keys.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
            <RiKeyLine
              className="mb-4 size-10 text-muted-foreground"
              aria-hidden="true"
            />
            <h3 className="mb-1 text-lg font-semibold text-balance">
              {t("emptyTitle")}
            </h3>
            <p className="mb-4 max-w-sm text-sm text-muted-foreground">
              {t("emptyDescription")}
            </p>
          </div>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colName")}</TableHead>
                  <TableHead>{t("colKey")}</TableHead>
                  <TableHead>{t("colScope")}</TableHead>
                  <TableHead>{t("colLastUsed")}</TableHead>
                  <TableHead>{t("colCreated")}</TableHead>
                  <TableHead>{t("colStatus")}</TableHead>
                  <TableHead className="w-32" />
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
          </div>
        )}
      </section>
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
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={onRotate}
              disabled={rotateKey.isPending}
            >
              <RiRefreshLine className="size-3.5" aria-hidden="true" />
              {t("rotate")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onRevoke}
              disabled={revokeKey.isPending}
            >
              {t("revoke")}
            </Button>
          </div>
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
