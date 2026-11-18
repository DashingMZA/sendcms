"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useCreateForm } from "@sendcms/forms/queries"
import { ApiClientError } from "@sendcms/shared"

import { Button, Input, Label, Switch, Textarea } from "@sendcms/ui"

export function NewFormForm() {
  const router = useRouter()
  const createForm = useCreateForm()
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [successMessage, setSuccessMessage] = useState("")
  const [redirectUrl, setRedirectUrl] = useState("")
  const [dailyLimit, setDailyLimit] = useState("")
  const [honeypotEnabled, setHoneypotEnabled] = useState(true)
  const [turnstileEnabled, setTurnstileEnabled] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    try {
      const created = await createForm.mutateAsync({
        name,
        description: description || undefined,
        successMessage: successMessage || undefined,
        redirectUrl: redirectUrl || undefined,
        dailyLimit: dailyLimit ? Number(dailyLimit) : undefined,
        honeypotEnabled,
        turnstileEnabled,
      })
      router.push(`/dashboard/forms/${created.id}`)
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Could not create this form."
      )
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-lg space-y-6">
      <div className="space-y-2">
        <Label htmlFor="name">Form name</Label>
        <Input
          id="name"
          type="text"
          autoComplete="off"
          placeholder="Contact us"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="description">Description (optional)</Label>
        <Textarea
          id="description"
          placeholder="Shown in the dashboard only — visitors never see it."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="successMessage">Success message (optional)</Label>
        <Input
          id="successMessage"
          type="text"
          autoComplete="off"
          placeholder="Thanks! We'll get back to you soon."
          value={successMessage}
          onChange={(e) => setSuccessMessage(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="redirectUrl">Redirect URL (optional)</Label>
        <Input
          id="redirectUrl"
          type="url"
          autoComplete="off"
          placeholder="https://example.com/thanks"
          value={redirectUrl}
          onChange={(e) => setRedirectUrl(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          After a successful submission the visitor is sent here instead of
          seeing the success message.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="dailyLimit">Daily submission limit (optional)</Label>
        <Input
          id="dailyLimit"
          type="number"
          min={1}
          max={100000}
          placeholder="Unlimited"
          value={dailyLimit}
          onChange={(e) => setDailyLimit(e.target.value)}
        />
      </div>

      <div className="flex items-center justify-between rounded-lg border p-4">
        <div>
          <Label htmlFor="honeypot">Honeypot spam trap</Label>
          <p className="text-xs text-muted-foreground">
            An invisible field bots fill in and humans never see.
          </p>
        </div>
        <Switch
          id="honeypot"
          checked={honeypotEnabled}
          onCheckedChange={setHoneypotEnabled}
        />
      </div>

      <div className="flex items-center justify-between rounded-lg border p-4">
        <div>
          <Label htmlFor="turnstile">Cloudflare Turnstile</Label>
          <p className="text-xs text-muted-foreground">
            Extra bot protection on the submission form (keys configured in
            Phase 5).
          </p>
        </div>
        <Switch
          id="turnstile"
          checked={turnstileEnabled}
          onCheckedChange={setTurnstileEnabled}
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <Button type="submit" disabled={createForm.isPending}>
        {createForm.isPending ? "Creating…" : "Create form"}
      </Button>
      <p className="text-xs text-muted-foreground">
        The form starts with name, email and message fields — you can add, edit
        or remove fields afterwards.
      </p>
    </form>
  )
}
