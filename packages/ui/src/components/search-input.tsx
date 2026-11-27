"use client"

import * as React from "react"
import { RiCloseLine, RiSearchLine } from "@remixicon/react"

import { cn } from "@sendcms/shared"

import { Input } from "./input"
import { Label } from "./label"

// Shared search field (PRF-027/PRF-030): every search input in the apps
// renders through this component, so the pattern cannot regress — the
// field always has a programmatic label and the clear button always
// meets the 24 px WCAG 2.2 minimum target size (the icon stays 16 px).
// Controlled: the caller owns the value and the (debounced) filtering;
// this component only renders the labelled field + clear button.
export function SearchInput({
  id,
  label,
  value,
  onChange,
  onClear,
  placeholder,
  clearLabel,
  className,
}: {
  // Unique per page — the visually-hidden <Label> points at it.
  id: string
  // Accessible name, rendered as a visually-hidden <Label>.
  label: string
  value: string
  onChange: (value: string) => void
  // Defaults to onChange("").
  onClear?: () => void
  placeholder?: string
  clearLabel: string
  // Extra classes for the <Input> (width etc.).
  className?: string
}) {
  function handleClear() {
    if (onClear) {
      onClear()
    } else {
      onChange("")
    }
  }

  return (
    <div className="relative">
      <Label htmlFor={id} className="sr-only">
        {label}
      </Label>
      <RiSearchLine
        aria-hidden="true"
        className="absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        id={id}
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn("h-9 w-64 ps-9 pe-9 text-sm", className)}
      />
      {value && (
        <button
          type="button"
          onClick={handleClear}
          aria-label={clearLabel}
          className="absolute end-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
        >
          <RiCloseLine aria-hidden="true" className="size-4" />
        </button>
      )}
    </div>
  )
}
