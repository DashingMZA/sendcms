"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { authClient } from "@sendcms/auth/client"

import { UpdateProfileSchema } from "@/lib/validators/auth"
import { Button, Input, Label } from "@sendcms/ui"

export function UpdateNameForm({
  currentName,
}: {
  currentName: string | null
}) {
  const router = useRouter()
  const [name, setName] = useState(currentName ?? "")
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setMessage(null)
    const parsed = UpdateProfileSchema.safeParse({ name })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Enter a name.")
      return
    }
    setLoading(true)
    const { error } = await authClient.updateUser({ name: parsed.data.name })
    setLoading(false)
    if (error) {
      setError(error.message ?? "Couldn't update your name.")
      return
    }
    setMessage("Name updated.")
    router.refresh()
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="account-name">Name</Label>
        <Input
          id="account-name"
          type="text"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {message && <p className="text-sm text-muted-foreground">{message}</p>}
      <Button type="submit" disabled={loading}>
        {loading ? "Saving…" : "Save name"}
      </Button>
    </form>
  )
}
