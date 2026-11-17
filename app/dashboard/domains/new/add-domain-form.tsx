"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useCreateDomain } from "@/lib/queries/domains"
import { ApiClientError } from "@/lib/api-client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { DomainVerificationMethod } from "@/generated/prisma/client"

export function AddDomainForm() {
  const router = useRouter()
  const createDomain = useCreateDomain()
  const [domain, setDomain] = useState("")
  const [method, setMethod] = useState<DomainVerificationMethod>("DNS_TXT")
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      const created = await createDomain.mutateAsync({ domain, method })
      router.push(`/dashboard/domains/${created.id}`)
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Could not add this domain."
      )
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-lg space-y-6">
      <div className="space-y-2">
        <Label htmlFor="domain">Domain</Label>
        <Input
          id="domain"
          type="text"
          autoComplete="off"
          placeholder="example.com"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          required
        />
        <p className="text-xs text-muted-foreground">
          A scheme, path or www prefix is stripped automatically —
          https://www.example.com/blog becomes example.com.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="method">Verification method</Label>
        <Select
          value={method}
          onValueChange={(v) => setMethod(v as DomainVerificationMethod)}
        >
          <SelectTrigger id="method">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="DNS_TXT">
              DNS TXT record (recommended)
            </SelectItem>
            <SelectItem value="META_TAG">HTML meta tag</SelectItem>
            <SelectItem value="FILE">Verification file</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          DNS TXT works for any host. The meta tag and file methods need your
          site to be reachable over HTTPS.
        </p>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <Button type="submit" disabled={createDomain.isPending}>
        {createDomain.isPending ? "Adding…" : "Add domain"}
      </Button>
    </form>
  )
}
