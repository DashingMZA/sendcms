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

function formatDate(value: string | Date | null) {
  if (!value) return "—"
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

export function ApiKeysManager({
  initialKeys,
}: {
  initialKeys: ApiKeyPublic[]
}) {
  const { data: keys = initialKeys } = useApiKeys(initialKeys)
  const createKey = useCreateApiKey()
  const [name, setName] = useState("")
  const [scope, setScope] = useState<"READ" | "FULL">("FULL")
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
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Could not create this API key."
      )
    }
  }

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      {newKey && (
        <section className="flex flex-col gap-3 rounded-lg border border-amber-500/50 bg-amber-500/5 p-4">
          <h2 className="text-sm font-semibold">
            Copy your new key now — it won&apos;t be shown again
          </h2>
          <CopyField
            label={newKeyName ?? "API key"}
            value={newKey}
            description="Anyone with this key can act as your account (within its scope). Store it in your MCP client, never in a public repo or a shared chat."
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
              I&apos;ve saved it
            </Button>
          </div>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
          Create a key
        </h2>
        <form onSubmit={onCreate} className="max-w-lg space-y-6">
          <div className="space-y-2">
            <Label htmlFor="key-name">Name</Label>
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
            <p className="text-xs text-muted-foreground">
              A label so you can tell keys apart later — it is shown in the list
              below.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="key-scope">Scope</Label>
            <Select
              value={scope}
              onValueChange={(v) => setScope(v as "READ" | "FULL")}
            >
              <SelectTrigger id="key-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="FULL">
                  Full — all 19 MCP tools, including mutations
                </SelectItem>
                <SelectItem value="READ">
                  Read-only — list, get and overview tools only
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Read-only keys can never create, update or delete anything — give
              those to clients you don&apos;t fully trust.
            </p>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" disabled={createKey.isPending}>
            {createKey.isPending ? "Creating…" : "Create API key"}
          </Button>
        </form>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-wider text-muted-foreground uppercase">
          Your keys
        </h2>
        {keys.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
            <RiKeyLine
              className="mb-4 size-10 text-muted-foreground"
              aria-hidden="true"
            />
            <h3 className="mb-1 text-lg font-semibold text-balance">
              No API keys yet
            </h3>
            <p className="mb-4 max-w-sm text-sm text-muted-foreground">
              Create a key above, then paste it into your MCP client as a bearer
              token for POST /api/mcp.
            </p>
          </div>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Status</TableHead>
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
  const revokeKey = useRevokeApiKey(apiKey.id)
  const rotateKey = useRotateApiKey(apiKey.id)
  const [error, setError] = useState<string | null>(null)
  const revoked = apiKey.revokedAt !== null

  async function onRevoke() {
    if (
      !window.confirm(
        `Revoke the key "${apiKey.name}"? MCP clients using it will stop working immediately.`
      )
    )
      return
    setError(null)
    try {
      await revokeKey.mutateAsync()
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Could not revoke the key."
      )
    }
  }

  async function onRotate() {
    if (
      !window.confirm(
        `Rotate the key "${apiKey.name}"? The old key stops working immediately and a new one is issued.`
      )
    )
      return
    setError(null)
    try {
      const rotated = await rotateKey.mutateAsync()
      // The fresh key is shown once, in the box above.
      onNewKey(rotated.key, rotated.name)
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Could not rotate the key."
      )
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
          {apiKey.scope === "FULL" ? "Full" : "Read-only"}
        </Badge>
      </TableCell>
      <TableCell>{formatDate(apiKey.lastUsedAt)}</TableCell>
      <TableCell>{formatDate(apiKey.createdAt)}</TableCell>
      <TableCell>
        {revoked ? (
          <Badge variant="outline">Revoked</Badge>
        ) : (
          <Badge variant="secondary">Active</Badge>
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
              Rotate
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onRevoke}
              disabled={revokeKey.isPending}
            >
              Revoke
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
