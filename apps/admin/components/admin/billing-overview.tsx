"use client"

import { useState } from "react"
import { toast } from "sonner"
import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import type { BillingProvider } from "@sendcms/database"
import { BILLING_PROVIDERS } from "@sendcms/billing/registry"
import {
  useBillingCountries,
  useBillingProviders,
  useSetBillingProviderConfig,
} from "@sendcms/billing/queries"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  ScrollArea,
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

// The billing overview (Phase 8): one row per provider with its
// env-configured state (booleans only, never values), its enabled
// switch, its country mapping, and whether checkout is implemented
// for it. The switch flips only after the mutation succeeds — the
// dialog asks for the reason the service requires and the countries
// to serve, and the displayed state comes from the query data.
// Enabling an unconfigured provider is refused by the service with
// a 422 naming the missing env vars.
export function BillingOverview({ actorRole }: Props) {
  const { t } = useTranslation("billing")
  const canViewBilling = adminCan(actorRole, "VIEW_BILLING")
  const canManageBilling = adminCan(actorRole, "MANAGE_BILLING")

  const { data: providers, isLoading } = useBillingProviders()
  const { data: countries } = useBillingCountries()

  // The pending change: null = no dialog open.
  const [pendingProvider, setPendingProvider] =
    useState<BillingProvider | null>(null)
  const [pendingEnabled, setPendingEnabled] = useState(false)
  const [pendingCountries, setPendingCountries] = useState<string[]>([])
  const [reason, setReason] = useState("")

  const setConfig = useSetBillingProviderConfig()

  if (!canViewBilling) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm text-muted-foreground">{t("noPermission")}</p>
        </CardContent>
      </Card>
    )
  }

  function openSwitchDialog(
    provider: BillingProvider,
    currentEnabled: boolean,
    currentCountries: string[]
  ) {
    setReason("")
    setPendingProvider(provider)
    setPendingEnabled(!currentEnabled)
    setPendingCountries(currentCountries)
  }

  async function confirmSwitch() {
    if (!pendingProvider) return
    try {
      const row = await setConfig.mutateAsync({
        provider: pendingProvider,
        input: {
          isEnabled: pendingEnabled,
          countries: pendingCountries,
          reason: reason.trim(),
        },
      })
      toast.success(t("updated"))
      // BIL-053: the enable succeeded, but with an empty Freemius
      // plan map no Freemius checkout can work — surface the
      // service's warning instead of leaving a silent trap.
      if (row.warning) toast.warning(row.warning)
      setPendingProvider(null)
      setReason("")
    } catch {
      // The query provider's global mutation error toast already
      // shows the failure — the dialog stays open to retry.
    }
  }

  function toggleCountry(code: string) {
    setPendingCountries((prev) =>
      prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]
    )
  }

  const pendingDefinition = pendingProvider
    ? BILLING_PROVIDERS.find((p) => p.id === pendingProvider)
    : null
  const pendingRow = pendingProvider
    ? providers?.find((p) => p.provider === pendingProvider)
    : undefined

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("colProvider")}</TableHead>
                  <TableHead>{t("colConfigured")}</TableHead>
                  <TableHead>{t("colEnabled")}</TableHead>
                  <TableHead>{t("colCountries")}</TableHead>
                  <TableHead>{t("colCheckout")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(providers ?? []).map((row) => {
                  const definition = BILLING_PROVIDERS.find(
                    (p) => p.id === row.provider
                  )
                  return (
                    <TableRow key={row.provider}>
                      <TableCell>
                        <p className="font-medium">{definition?.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {definition?.feeNote}
                        </p>
                        {/* BIL-053: the Freemius plan map is env JSON,
                            not DB rows — surface how many versions it
                            maps so an empty map is visible here. */}
                        {row.planMapCount !== null && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {t("freemiusPlansMapped")}: {row.planMapCount}
                            {row.planMapCount === 0 &&
                              ` — ${t("freemiusNoPlansMapped")}`}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={row.configured ? "secondary" : "destructive"}
                        >
                          {row.configured
                            ? t("configuredYes")
                            : t("configuredNo")}
                        </Badge>
                        {!row.configured && row.missingEnvVars.length > 0 && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {t("missingVars")}: {row.missingEnvVars.join(", ")}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={row.isEnabled}
                          // BIL-127: an unconfigured provider cannot be
                          // enabled — the switch is disabled instead of
                          // inviting a doomed dialog flow. Disabling an
                          // already-enabled provider stays possible.
                          // The service's 422 stays as defence in depth.
                          disabled={
                            !canManageBilling ||
                            (!row.configured && !row.isEnabled)
                          }
                          onCheckedChange={() =>
                            openSwitchDialog(
                              row.provider,
                              row.isEnabled,
                              row.countries
                            )
                          }
                          aria-label={definition?.label}
                        />
                        {!row.configured && !row.isEnabled && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {t("enableDisabledHint")}:{" "}
                            {row.missingEnvVars.join(", ")}
                          </p>
                        )}
                      </TableCell>
                      <TableCell>
                        {row.allCountries
                          ? t("allCountries")
                          : row.countries.join(", ")}
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            row.checkoutImplemented ? "secondary" : "outline"
                          }
                        >
                          {row.checkoutImplemented
                            ? t("checkoutAvailable")
                            : t("checkoutNotAvailable")}
                        </Badge>
                        {/* BIL-095: Gumroad has no checkout API and no
                            webhook route — the note explains the
                            manual-activation flow instead of leaving
                            a bare "not available" badge. */}
                        {row.note && (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {row.note}
                          </p>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={pendingProvider !== null}
        onOpenChange={(open) => {
          if (!open) setPendingProvider(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingEnabled ? t("enableTitle") : t("disableTitle")}
              {pendingDefinition ? ` — ${pendingDefinition.label}` : ""}
            </DialogTitle>
            <DialogDescription>{pendingDefinition?.feeNote}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            {/* BIL-053: warn before the save, not only after it —
                enabling Freemius with no mapped plan version leaves
                a provider that cannot sell. */}
            {pendingProvider === "FREEMIUS" &&
              pendingEnabled &&
              pendingRow?.planMapCount === 0 && (
                <p className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                  {t("freemiusEmptyMapWarning")}
                </p>
              )}
            <div className="flex flex-col gap-2">
              <Label htmlFor="billing-reason">{t("reasonLabel")}</Label>
              <Textarea
                id="billing-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t("reasonPlaceholder")}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label>{t("countriesLabel")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("countriesHint")}
              </p>
              <ScrollArea className="h-48 rounded-md border p-3">
                <div className="flex flex-col gap-2">
                  {(countries ?? []).map((country) => (
                    <label
                      key={country.code}
                      className="flex cursor-pointer items-center gap-2 text-sm"
                    >
                      <Checkbox
                        checked={pendingCountries.includes(country.code)}
                        onCheckedChange={() => toggleCountry(country.code)}
                      />
                      {country.name} ({country.code})
                    </label>
                  ))}
                </div>
              </ScrollArea>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingProvider(null)}>
              {t("cancel")}
            </Button>
            <Button
              onClick={confirmSwitch}
              disabled={!reason.trim() || setConfig.isPending}
            >
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
