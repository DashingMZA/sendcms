"use client"

import { useState } from "react"
import { toast } from "sonner"
import { useCancelMySubscription } from "@sendcms/billing/queries"
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

// BIL-122 / BIL-091 (Wave 6): the customer cancel button + confirm
// dialog. Immediate cancel, or cancel at the end of the current
// period. LOCAL ONLY until Wave 8 wires the provider cancel
// (BIL-001 / BIL-082) — the dialog says so, so a paying customer is
// not left thinking the provider billing stopped.
export function CancelSubscription() {
  const { t } = useTranslation("billing")
  const [open, setOpen] = useState(false)
  const [cancelAtPeriodEnd, setCancelAtPeriodEnd] = useState(false)
  const cancel = useCancelMySubscription()

  async function onConfirm() {
    try {
      await cancel.mutateAsync({ cancelAtPeriodEnd })
      setOpen(false)
      toast.success(t("subscriptionCanceled"))
    } catch {
      // The error is shown inline in the dialog; the page stays put.
    }
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        {t("cancelSubscription")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("cancelConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("cancelConfirmDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Checkbox
                id="cancel-at-period-end"
                checked={cancelAtPeriodEnd}
                onCheckedChange={(checked) =>
                  setCancelAtPeriodEnd(checked === true)
                }
              />
              <Label htmlFor="cancel-at-period-end">
                {t("cancelAtPeriodEndLabel")}
              </Label>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("providerCancelNote")}
            </p>
            {cancel.isError && (
              <p className="text-sm text-destructive">{t("cancelFailed")}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={onConfirm}
              disabled={cancel.isPending}
            >
              {t("cancelNow")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
