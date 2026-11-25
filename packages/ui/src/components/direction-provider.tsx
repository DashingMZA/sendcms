// packages/ui/src/components/direction-provider.tsx
// Radix Direction provider (I18N-303): without it, Radix primitives
// (Select, DropdownMenu, Dialog, Sheet, Tooltip) render `dir="ltr"`
// inside RTL pages, so their popups, chevrons and slide animations
// never mirror. The app root layouts wrap their theme provider with
// this component, passing the page direction (`ltr` | `rtl`).
// Client-safe: `radix-ui` re-exports `@radix-ui/react-direction`.
"use client"

import { Direction as DirectionPrimitive } from "radix-ui"
import type { ReactNode } from "react"

export function DirectionProvider({
  dir,
  children,
}: {
  dir: "ltr" | "rtl"
  // Optional so `React.createElement(DirectionProvider, { dir }, child)`
  // type-checks: the props object need not carry `children` when they
  // are passed as separate arguments. All real call sites pass children.
  children?: ReactNode
}) {
  return (
    <DirectionPrimitive.Provider dir={dir}>
      {children}
    </DirectionPrimitive.Provider>
  )
}
