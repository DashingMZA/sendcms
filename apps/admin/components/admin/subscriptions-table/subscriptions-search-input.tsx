// Debounced subscription search input (Wave 10, SRC-118 split of
// subscriptions-table.tsx). Same shape as the users table's search
// input: debounced, URL-as-state (`q`), resets to page 1.
"use client"

import { useRef, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { RiCloseLine, RiSearchLine } from "@remixicon/react"
import { Input } from "@sendcms/ui"
import { useTranslation } from "@/components/admin/translation-provider"

const DEBOUNCE_MS = 300

export function SubscriptionsSearchInput({
  defaultValue = "",
}: {
  defaultValue?: string
}) {
  const { t } = useTranslation("subscriptions")
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [value, setValue] = useState(defaultValue)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function updateSearch(search: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (search.trim()) {
      params.set("q", search.trim())
    } else {
      params.delete("q")
    }
    params.delete("page")
    const text = params.toString()
    router.push(text ? `${pathname}?${text}` : pathname)
  }

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
      <RiSearchLine className="absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
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
          aria-label={t("clearFilters")}
        >
          <RiCloseLine className="size-4" />
        </button>
      )}
    </div>
  )
}
