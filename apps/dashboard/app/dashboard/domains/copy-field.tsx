"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@sendcms/ui"

import { Copy, Check } from "lucide-react"
import { useTranslation } from "@/components/dashboard/translation-provider"

// One labelled value with its own copy button — DNS records have two
// values (name + value) and each must be copied separately. The
// `domain` prop selects which page dictionary the Copy/Copied strings
// come from: this component is shared by the domains, forms, api and
// api-keys pages, and each page only loads its own domain.
export function CopyField({
  label,
  value,
  description,
  domain,
}: {
  label: string
  value: string
  description?: string
  domain: string
}) {
  const { t } = useTranslation(domain)
  const [copied, setCopied] = useState(false)

  async function copy() {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    toast.success(t("copiedToClipboard", { label }))
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="rounded-lg border bg-muted/50">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={copy}
        >
          {copied ? (
            <Check className="text-success size-3.5" />
          ) : (
            <Copy className="size-3.5" />
          )}
          {copied ? t("copied") : t("copy")}
        </Button>
      </div>
      <pre
        dir="ltr"
        className="overflow-x-auto p-4 font-mono text-sm leading-relaxed"
      >
        <code>{value}</code>
      </pre>
      {description && (
        <p className="border-t px-4 py-2 text-xs text-muted-foreground">
          {description}
        </p>
      )}
    </div>
  )
}
