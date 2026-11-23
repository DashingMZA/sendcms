"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@sendcms/ui"

import { Copy, Check } from "lucide-react"
import { useTranslation } from "@/components/dashboard/translation-provider"

type Props = {
  code: string
  language?: string
  // Which page dictionary the Copy/Copied strings come from: this
  // component is shared by the domains, forms and api pages, and each
  // page only loads its own domain.
  domain: string
}

export function InstallSnippet({ code, language = "html", domain }: Props) {
  const { t } = useTranslation(domain)
  const [copied, setCopied] = useState(false)

  async function copy() {
    await navigator.clipboard.writeText(code)
    setCopied(true)
    toast.success(t("snippetCopiedToClipboard"))
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="relative rounded-lg border bg-muted/50">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <span className="font-mono text-xs text-muted-foreground">
          {language}
        </span>
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
      <pre className="overflow-x-auto p-4 font-mono text-sm leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  )
}
