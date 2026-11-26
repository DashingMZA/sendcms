"use client"

import { useState } from "react"
import type { AiProviderName } from "@sendcms/ai"
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
} from "@sendcms/ui"
import { useTranslation } from "@/components/dashboard/translation-provider"

export type PendingStorageAction = {
  provider: AiProviderName
  apiKey: string
  model: string
  action: "save" | "test"
}

/**
 * The storage popup (Wave 10, SRC-118: split out of ai-manager.tsx by
 * concern): when a user saves or tests a key, they pick where it lives
 * — "Browser only" (this browser, never the server) or "Both (browser
 * + server)" (encrypted in the database, works from any device).
 */
export function StoragePopup({
  pending,
  displayName,
  onClose,
  onBrowserOnly,
  onBoth,
}: {
  pending: PendingStorageAction | null
  displayName: string
  onClose: () => void
  onBrowserOnly: (action: PendingStorageAction) => void
  onBoth: (
    action: PendingStorageAction,
    termsAcknowledged: boolean
  ) => Promise<void>
}) {
  const { t } = useTranslation("ai")
  const [busy, setBusy] = useState(false)
  // AIM-025: saving a key on the server sends submission content to
  // the provider under its data-processing terms — the user must
  // acknowledge that before "Both" is enabled.
  const [termsAcknowledged, setTermsAcknowledged] = useState(false)

  if (!pending) return null
  // Narrowed once here: function declarations are hoisted, so TS
  // would not narrow `pending` inside chooseBoth on its own.
  const action = pending

  async function chooseBoth() {
    setBusy(true)
    try {
      await onBoth(action, termsAcknowledged)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t("storageTitle")} — {displayName}
          </DialogTitle>
          <DialogDescription>{t("storageDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => onBrowserOnly(pending)}
            className="rounded-lg border p-4 text-start hover:bg-accent"
          >
            <span className="block text-sm font-semibold">
              {t("browserOnly")}
            </span>
            <span className="block text-sm text-muted-foreground">
              {t("browserOnlyDescription")}
            </span>
          </button>
          <button
            type="button"
            onClick={chooseBoth}
            disabled={busy || !termsAcknowledged}
            className="rounded-lg border p-4 text-start hover:bg-accent disabled:opacity-50"
          >
            <span className="block text-sm font-semibold">{t("both")}</span>
            <span className="block text-sm text-muted-foreground">
              {t("bothDescription")}
            </span>
          </button>
          <div className="flex items-start gap-2 rounded-lg border p-3">
            <Checkbox
              id="ai-terms-acknowledgement"
              checked={termsAcknowledged}
              onCheckedChange={(checked) =>
                setTermsAcknowledged(checked === true)
              }
            />
            <Label
              htmlFor="ai-terms-acknowledgement"
              className="text-sm font-normal"
            >
              {t("termsAcknowledgement")}
            </Label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
