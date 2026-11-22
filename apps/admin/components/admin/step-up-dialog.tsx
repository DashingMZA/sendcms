"use client"

import { useState } from "react"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@sendcms/ui"
import { ApiClientError } from "@sendcms/shared"
import { useTranslation } from "@/components/admin/translation-provider"
import { useVerifyStepUp } from "./use-step-up"

// Step-up password dialog (Admin Control Plane, Phase 9): shared by
// all five high-impact admin action sites (user disable, role
// change, deletion approve/erase, API key revoke, MCP kill-switch
// toggle). The action button opens this dialog first; only after a
// successful verification does `onVerified` run the action.
//
// The password lives only in this component's state and is cleared
// on close and on success — it is never stored, never logged, and
// never leaves this dialog except in the verify request body.
export function StepUpDialog({
  open,
  onOpenChange,
  onVerified,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onVerified: () => void
}) {
  const { t } = useTranslation("step-up")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const verify = useVerifyStepUp()

  function close() {
    setPassword("")
    setError(null)
    onOpenChange(false)
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (password.length === 0) return
    setError(null)
    try {
      await verify.mutateAsync(password)
      setPassword("")
      setError(null)
      onOpenChange(false)
      onVerified()
    } catch (err) {
      // Inline error, keyed by status: the dialog stays open so the
      // admin can retry (or go set a password first). Any other
      // failure surfaces its message; the global toast stays silent
      // for this mutation (meta.silent in use-step-up).
      if (err instanceof ApiClientError) {
        if (err.status === 403) setError(t("wrongPassword"))
        else if (err.status === 422) setError(t("noPasswordSet"))
        else if (err.status === 429) setError(t("tooManyAttempts"))
        else setError(err.message)
      } else {
        setError(err instanceof Error ? err.message : t("wrongPassword"))
      }
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
        else onOpenChange(true)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="space-y-1">
            <Label htmlFor="step-up-password">{t("passwordLabel")}</Label>
            <Input
              id="step-up-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("passwordPlaceholder")}
              disabled={verify.isPending}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t("cancel")}
            </Button>
            <Button
              type="submit"
              disabled={verify.isPending || password.length === 0}
            >
              {verify.isPending ? t("verifying") : t("verify")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
