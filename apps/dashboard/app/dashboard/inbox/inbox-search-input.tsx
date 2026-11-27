"use client"

import { useState, useCallback, useRef } from "react"
import { useRouter, usePathname, useSearchParams } from "next/navigation"
import { SearchInput } from "@sendcms/ui"
import { useTranslation } from "@/components/dashboard/translation-provider"

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
      id="inbox-search"
      label={t("searchPlaceholder")}
      placeholder={t("searchPlaceholder")}
      value={value}
      onChange={handleChange}
      onClear={handleClear}
      clearLabel={t("clearSearch")}
    />
  )
}
