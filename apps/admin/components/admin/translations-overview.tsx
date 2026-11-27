"use client"

import { Fragment, useState } from "react"
import { toast } from "sonner"
import {
  adminCan,
  type AdminRole,
  type PlatformRole,
} from "@sendcms/permissions"
import { useTranslationCompletion } from "@sendcms/platform-ops/queries"
import { apiFetch } from "@sendcms/shared"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@sendcms/ui"
import { useTranslation } from "@/components/admin/translation-provider"
import { downloadJson } from "@/lib/download-json"

type Props = {
  actorRole: PlatformRole | AdminRole
}

/**
 * The translation management page (Phase 7) — READ-ONLY. Per-locale
 * completion with the per-domain breakdown, the missing keys per
 * domain, and a JSON export per locale. No edit or write UI exists
 * anywhere here: no ordinary admin may overwrite translation files
 * from the browser. The page is a management page
 * (MANAGE_TRANSLATIONS), so an actor without it gets the
 * no-permission card and the completion query never fires.
 */
export function TranslationsOverview({ actorRole }: Props) {
  const { t } = useTranslation("translations")
  const canManage = adminCan(actorRole, "MANAGE_TRANSLATIONS")

  if (!canManage) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <p className="text-sm text-muted-foreground">{t("noPermission")}</p>
        </CardContent>
      </Card>
    )
  }

  return <TranslationsInner />
}

function TranslationsInner() {
  const { t } = useTranslation("translations")
  const { data, isLoading } = useTranslationCompletion()
  // Which locale's per-domain breakdown is expanded.
  const [expanded, setExpanded] = useState<string | null>(null)
  // Which domain's missing keys are shown (per expanded locale).
  const [missingFor, setMissingFor] = useState<string | null>(null)
  const [exporting, setExporting] = useState<string | null>(null)

  const locales = data?.locales ?? []

  async function exportLocale(code: string) {
    setExporting(code)
    try {
      // SRC-109: the export goes through apiFetch, not raw fetch —
      // typed errors + the same auth/timeout handling as every other
      // client call.
      const body = await apiFetch<unknown>(
        `/api/v1/admin/translations/${code}/export`
      )
      downloadJson(body, `sendcms-translations-${code}.json`)
      toast.success(t("exported"))
    } catch {
      toast.error(t("export"))
    } finally {
      setExporting(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">{t("readOnlyNote")}</p>

      <Card>
        <CardHeader>
          <CardTitle as="h2">{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : locales.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t("noLocales")}
            </p>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("colLocale")}</TableHead>
                    <TableHead>{t("colDirection")}</TableHead>
                    <TableHead>{t("colStatus")}</TableHead>
                    <TableHead>{t("colCompletion")}</TableHead>
                    <TableHead>{t("colActions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {locales.map((locale) => (
                    <Fragment key={locale.code}>
                      <TableRow>
                        <TableCell>
                          <p className="font-medium">{locale.name}</p>
                          <p className="text-sm text-muted-foreground">
                            {locale.nativeName} · {locale.code}
                          </p>
                        </TableCell>
                        <TableCell className="text-sm">
                          {locale.dir === "rtl" ? t("rtl") : t("ltr")}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              locale.status === "complete"
                                ? "secondary"
                                : "outline"
                            }
                          >
                            {locale.status === "complete"
                              ? t("complete")
                              : t("comingSoon")}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div className="h-2 w-24 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full bg-primary"
                                style={{
                                  width: `${Math.min(100, Math.max(0, locale.overallPercent))}%`,
                                }}
                              />
                            </div>
                            <span className="text-sm font-medium tabular-nums">
                              {locale.overallPercent}%
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                setExpanded(
                                  expanded === locale.code ? null : locale.code
                                )
                              }
                            >
                              {expanded === locale.code
                                ? t("hideDomains")
                                : t("showDomains")}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => exportLocale(locale.code)}
                              disabled={exporting === locale.code}
                            >
                              {exporting === locale.code
                                ? t("exporting")
                                : t("export")}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                      {expanded === locale.code && (
                        <TableRow key={`${locale.code}-domains`}>
                          <TableCell colSpan={5}>
                            <div className="rounded-lg border">
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead>{t("colDomain")}</TableHead>
                                    <TableHead>{t("colApp")}</TableHead>
                                    <TableHead>{t("colTranslated")}</TableHead>
                                    <TableHead>{t("colMissing")}</TableHead>
                                    <TableHead>{t("colActions")}</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {locale.domains.map((domain) => {
                                    const missingKey = `${locale.code}/${domain.app}/${domain.domain}`
                                    const missingShown =
                                      missingFor === missingKey
                                    return (
                                      <Fragment
                                        key={`${domain.app}/${domain.domain}`}
                                      >
                                        <TableRow>
                                          <TableCell className="font-mono text-sm">
                                            {domain.domain}
                                          </TableCell>
                                          <TableCell className="text-sm">
                                            {domain.app}
                                          </TableCell>
                                          <TableCell className="text-sm tabular-nums">
                                            {domain.translated} / {domain.total}
                                          </TableCell>
                                          <TableCell className="text-sm tabular-nums">
                                            {domain.missingKeys.length}
                                          </TableCell>
                                          <TableCell>
                                            {domain.missingKeys.length > 0 && (
                                              <Button
                                                variant="outline"
                                                size="sm"
                                                onClick={() =>
                                                  setMissingFor(
                                                    missingShown
                                                      ? null
                                                      : missingKey
                                                  )
                                                }
                                              >
                                                {missingShown
                                                  ? t("hideMissing")
                                                  : t("showMissing")}
                                              </Button>
                                            )}
                                          </TableCell>
                                        </TableRow>
                                        {missingShown && (
                                          <TableRow
                                            key={`${domain.app}/${domain.domain}-missing`}
                                          >
                                            <TableCell colSpan={5}>
                                              <div className="flex flex-wrap gap-1">
                                                {domain.missingKeys.map(
                                                  (key) => (
                                                    <code
                                                      key={key}
                                                      className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
                                                    >
                                                      {key}
                                                    </code>
                                                  )
                                                )}
                                              </div>
                                            </TableCell>
                                          </TableRow>
                                        )}
                                      </Fragment>
                                    )
                                  })}
                                </TableBody>
                              </Table>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
