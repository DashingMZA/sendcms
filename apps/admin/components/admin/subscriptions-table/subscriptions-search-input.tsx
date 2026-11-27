// Debounced subscription search input (Wave 10, SRC-118 split of
// subscriptions-table.tsx). Same shape as the users table's search
// input: debounced, URL-as-state (`q`), resets to page 1.
"use client"

import { useCallback, useRef, useState } from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { SearchInput } from "@sendcms/ui"
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

  const updateSearch = useCallback(
    (search: string) => {
      const params = new URLSearchParams(searchParams.toString())
      if (search.trim()) {
        params.set("q", search.trim())
      } else {
        params.delete("q")
      }
      params.delete("page")
      const text = params.toString()
      router.push(text ? `${pathname}?${text}` : pathname)
    },
    [pathname, router, searchParams]
  )

  function handleChange(next: string) {
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
    <SearchInput
      id="subscriptions-search"
      label={t("searchPlaceholder")}
      placeholder={t("searchPlaceholder")}
      value={value}
      onChange={handleChange}
      onClear={handleClear}
      clearLabel={t("clearFilters")}
    />
  )
}
