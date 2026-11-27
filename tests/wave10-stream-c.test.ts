/**
 * @vitest-environment jsdom
 */
// Wave 10, Stream C — regression tests for SRC-322 (theme hotkey),
// SRC-328(d) (logo dimensions) and SRC-328(e) (chart style injection),
// and SDK-030 (marketing docs links). No test hits the network or the
// DB. React is rendered without JSX (vitest only includes *.test.ts)
// and without @testing-library: renderToStaticMarkup for the pure
// markup cases, createRoot + act for the keydown dispatch case.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { renderToStaticMarkup } from "react-dom/server"

// next-themes is NOT mocked: the dispatch tests run the real provider
// (the repo has no @testing-library, and the package is a transitive
// dep of @sendcms/ui, so vi.mock("next-themes") cannot resolve it from
// tests/). jsdom has no matchMedia, which next-themes calls during
// render — stub it to a light system theme.
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

// next/image is mocked for the Logo tests: the mock renders a plain
// <img> carrying the width/height Logo computed, so the test asserts
// the dimensions Logo passes instead of next/image internals.
vi.mock("next/image", async () => {
  const ReactModule = await import("react")
  return {
    default: (props: Record<string, unknown>) => {
      const { priority, ...imgProps } = props as {
        priority?: unknown
      } & Record<string, unknown>
      void priority
      return ReactModule.createElement("img", imgProps)
    },
  }
})

import {
  isThemeToggleHotkey,
  ThemeProvider,
} from "@/packages/ui/src/components/theme-provider"
import { Logo } from "@/packages/ui/src/components/logo"
import { ChartStyle } from "@/packages/ui/src/components/chart"
import { docsUrl, resolveLink } from "@/apps/marketing/lib/app-links"

// React 19 act() needs the environment flag in a jsdom test, or it
// warns and falls back to sync behaviour.
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const BRAND = {
  logo: "/images/logo.png",
  logo_darkmode: "/images/logo-darkmode.png",
  logo_width: "208",
  logo_height: "50",
  logo_text: "SendCMS",
}

describe("theme hotkey predicate (SRC-322)", () => {
  it("rejects a bare d keydown", () => {
    expect(
      isThemeToggleHotkey({
        key: "d",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
      })
    ).toBe(false)
  })

  it("accepts Ctrl+Shift+D and Cmd+Shift+D", () => {
    const base = {
      key: "D",
      metaKey: false,
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
    }
    expect(isThemeToggleHotkey({ ...base, ctrlKey: true })).toBe(true)
    expect(isThemeToggleHotkey({ ...base, metaKey: true })).toBe(true)
  })

  it("rejects the chord without Shift, with Alt, or on another key", () => {
    const base = {
      key: "d",
      metaKey: false,
      ctrlKey: true,
      shiftKey: true,
      altKey: false,
    }
    expect(isThemeToggleHotkey({ ...base, shiftKey: false })).toBe(false)
    expect(isThemeToggleHotkey({ ...base, altKey: true })).toBe(false)
    expect(isThemeToggleHotkey({ ...base, key: "x" })).toBe(false)
  })
})

describe("theme hotkey dispatch (SRC-322)", () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(async () => {
    window.localStorage.clear()
    document.documentElement.className = ""
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        React.createElement(ThemeProvider, null, React.createElement("div"))
      )
    })
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
    document.documentElement.className = ""
  })

  it("a bare d keydown does not change the theme", async () => {
    await act(async () => {
      window.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "d", bubbles: true })
      )
    })
    expect(document.documentElement.classList.contains("dark")).toBe(false)
  })

  it("Ctrl+Shift+D toggles the theme to dark", async () => {
    await act(async () => {
      window.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "D",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        })
      )
    })
    expect(document.documentElement.classList.contains("dark")).toBe(true)
  })

  it("the chord inside a text input does not toggle the theme", async () => {
    const input = document.createElement("input")
    document.body.appendChild(input)
    await act(async () => {
      input.dispatchEvent(
        new window.KeyboardEvent("keydown", {
          key: "D",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
        })
      )
    })
    expect(document.documentElement.classList.contains("dark")).toBe(false)
    input.remove()
  })
})

describe("Logo dimensions (SRC-328(d))", () => {
  it('falls back to the default size for logo_width "abc" without throwing', () => {
    const markup = renderToStaticMarkup(
      React.createElement(Logo, {
        brand: { ...BRAND, logo_width: "abc", logo_height: "abc" },
      })
    )
    // Default 208x50, rendered at the DISPLAY size (PRF-008, Wave 11):
    // the logo displays at most 160px wide (max-w-40), so the width /
    // height attributes are the display size (160x38, aspect kept),
    // with the 2x DPR variant served via the srcset (160w / 320w) —
    // not by requesting a 2x-sized image as the layout size.
    expect(markup).toContain('width="160"')
    expect(markup).toContain('height="38"')
  })

  it("uses configured numeric dimensions when they are valid", () => {
    const markup = renderToStaticMarkup(
      React.createElement(Logo, {
        brand: { ...BRAND, logo_width: "100", logo_height: "25" },
      })
    )
    // Configured 100x25 is under the 160px display cap, so it renders
    // at its own size (PRF-008, Wave 11 — display size, not 2x).
    expect(markup).toContain('width="100"')
    expect(markup).toContain('height="25"')
  })
})

describe("ChartStyle injection (SRC-328(e))", () => {
  it("escapes a chart id with CSS metacharacters — no extra rule", () => {
    const id = "x] {} evil"
    const markup = renderToStaticMarkup(
      React.createElement(ChartStyle, {
        id,
        config: { good: { label: "Good", color: "var(--chart-1)" } },
      })
    )
    expect(markup).toContain(`[data-chart="${CSS.escape(id)}"]`)
    expect(markup).not.toContain("[data-chart=x]")
  })

  it("drops color values that fail the safe pattern", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ChartStyle, {
        id: "chart-1",
        config: {
          good: { label: "Good", color: "var(--chart-1)" },
          bad: { label: "Bad", color: "red; } .evil { color: blue" },
        },
      })
    )
    expect(markup).toContain("--color-good: var(--chart-1);")
    expect(markup).not.toContain("--color-bad:")
    expect(markup).not.toContain("evil")
  })

  it("keeps plain hex and named colors", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ChartStyle, {
        id: "chart-1",
        config: {
          hex: { label: "Hex", color: "#0f766e" },
          named: { label: "Named", color: "transparent" },
        },
      })
    )
    expect(markup).toContain("--color-hex: #0f766e;")
    expect(markup).toContain("--color-named: transparent;")
  })
})

describe("marketing docs links (SDK-030)", () => {
  const ORIGINAL_DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL

  afterEach(() => {
    if (ORIGINAL_DOCS_URL === undefined) {
      delete process.env.NEXT_PUBLIC_DOCS_URL
    } else {
      process.env.NEXT_PUBLIC_DOCS_URL = ORIGINAL_DOCS_URL
    }
  })

  it("docsUrl() falls back to the docs dev port", () => {
    delete process.env.NEXT_PUBLIC_DOCS_URL
    expect(docsUrl()).toBe("http://localhost:3003")
  })

  it("docsUrl() reads NEXT_PUBLIC_DOCS_URL and strips a trailing slash", () => {
    process.env.NEXT_PUBLIC_DOCS_URL = "https://docs.sendcms.bond/"
    expect(docsUrl()).toBe("https://docs.sendcms.bond")
  })

  it('resolveLink("/docs/sdk") returns the docs origin', () => {
    delete process.env.NEXT_PUBLIC_DOCS_URL
    expect(resolveLink("/docs/sdk")).toBe("http://localhost:3003/docs/sdk")
  })

  it("resolveLink still routes /changelog, /sign-in, anchors and absolute URLs", () => {
    delete process.env.NEXT_PUBLIC_DOCS_URL
    expect(resolveLink("/changelog")).toBe("http://localhost:3004/changelog")
    expect(resolveLink("/sign-in")).toBe("http://localhost:3002/sign-in")
    expect(resolveLink("#how-it-works")).toBe("#how-it-works")
    expect(resolveLink("https://github.com/DashingMZA/sendcms")).toBe(
      "https://github.com/DashingMZA/sendcms"
    )
  })
})
