"use client"

import { useState, useCallback, useRef } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { Input } from "@sendcms/ui"
import { useTranslation } from "@/components/dashboard/translation-provider"

import { Search, X } from "lucide-react"

const DEBOUNCE_MS = 300

/** Debounced search that keeps the other inbox filters in the URL and
    resets to page 1 on change. */
export function InboxSearchInput({
  defaultValue = "",
}: {
  defaultValue?: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { t } = useTranslation("inbox")

  const [value, setValue] = useState(defaultValue)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const updateSearch = useCallback(
    (search: string) => {
      const params = new URLSearchParams(searchParams.toString())
      if (search.trim()) {
        params.set("search", search.trim())
      } else {
        params.delete("search")
      }
      params.delete("page")
      router.push(`${pathname}?${params.toString()}`)
    },
    [pathname, router, searchParams]
  )

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.value
    setValue(next)

    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }
    debounceRef.current = setTimeout(() => {
      updateSearch(next)
    }, DEBOUNCE_MS)
  }

  function handleClear() {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }
    setValue("")
    updateSearch("")
  }

  return (
    <div className="relative">
      <Search className="absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="text"
        placeholder={t("searchPlaceholder")}
        value={value}
        onChange={handleChange}
        className="h-9 w-64 ps-9 pe-9 text-sm"
      />
      {value && (
        <button
          type="button"
          onClick={handleClear}
          className="absolute end-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
          aria-label={t("clearSearch")}
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  )
}
