"use client"

import { useEffect, useRef } from "react"
import { usePathname } from "next/navigation"

// PRF-028: the App Router does not move focus on navigation, so after a
// route change focus stayed on the (now unmounted) sidebar link. Move it
// to the page's main landmark instead — every shell renders
// `#main-content` with `tabIndex={-1}` (SidebarInset, AuthShell, the
// admin pages), so this one component covers the whole app. The first
// render is skipped: a fresh page load already starts at the top.
export function FocusMainOnRouteChange() {
  const pathname = usePathname()
  const firstRender = useRef(true)

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    document.getElementById("main-content")?.focus({ preventScroll: true })
  }, [pathname])

  return null
}
