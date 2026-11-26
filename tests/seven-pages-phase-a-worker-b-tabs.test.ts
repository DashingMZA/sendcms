/**
 * @vitest-environment jsdom
 */
// Phase A Worker B — Plans & Subscriptions tabs: render + switch.
// Renders the real PlansSubscriptionsTabs shell (no JSX: vitest only
// includes *.test.ts) with stub table nodes, so the test exercises the
// shared-Tabs wiring itself — default tab, switching unmounts the
// inactive table, and the Plans tab is hidden without
// VIEW_PLAN_VERSIONS. The real tables are covered by the service +
// page wiring tests in seven-pages-phase-a-worker-b.test.ts; they are
// stubbed here so this test needs no QueryClient, router, or
// translation provider.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { PlansSubscriptionsTabs } from "../apps/admin/components/admin/plans-subscriptions-tabs"

// next/image is mocked for the @sendcms/ui barrel (the Logo component
// imports it; the mock renders a plain <img>). jsdom has no
// matchMedia, which next-themes calls during render — stub it to a
// light system theme. Same setup as tests/wave10-stream-c.test.ts.
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

// React 19 act() needs the environment flag in a jsdom test, or it
// warns and falls back to sync behaviour.
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const LABELS = { plans: "Plans", subscriptions: "Subscriptions" }

function stubTable(testId: string, text: string) {
  return React.createElement("div", { "data-testid": testId }, text)
}

function tabTrigger(container: HTMLElement, label: string) {
  const triggers = Array.from(
    container.querySelectorAll('[role="tab"]')
  ) as HTMLButtonElement[]
  const trigger = triggers.find((el) => el.textContent === label)
  if (!trigger) throw new Error(`no tab trigger labelled ${label}`)
  return trigger
}

describe("PlansSubscriptionsTabs — render + switch", () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  })

  async function renderTabs(props: {
    canViewPlans: boolean
    plansTable?: React.ReactNode
    subscriptionsTable: React.ReactNode
  }) {
    await act(async () => {
      root.render(
        React.createElement(PlansSubscriptionsTabs, {
          canViewPlans: props.canViewPlans,
          labels: LABELS,
          plansTable: props.plansTable,
          subscriptionsTable: props.subscriptionsTable,
        })
      )
    })
  }

  it("renders both tabs and shows the plans table by default", async () => {
    await renderTabs({
      canViewPlans: true,
      plansTable: stubTable("plans-table", "Plans table"),
      subscriptionsTable: stubTable(
        "subscriptions-table",
        "Subscriptions table"
      ),
    })
    const triggers = container.querySelectorAll('[role="tab"]')
    expect(triggers).toHaveLength(2)
    expect(tabTrigger(container, "Plans").dataset.state).toBe("active")
    expect(tabTrigger(container, "Subscriptions").dataset.state).toBe(
      "inactive"
    )
    expect(
      container.querySelector('[data-testid="plans-table"]')
    ).not.toBeNull()
    // Radix Tabs unmounts inactive content: only the active table is
    // in the DOM.
    expect(
      container.querySelector('[data-testid="subscriptions-table"]')
    ).toBeNull()
  })

  it("switches to the subscriptions tab and unmounts the plans table", async () => {
    await renderTabs({
      canViewPlans: true,
      plansTable: stubTable("plans-table", "Plans table"),
      subscriptionsTable: stubTable(
        "subscriptions-table",
        "Subscriptions table"
      ),
    })
    // Radix TabsTrigger activates on mousedown (button 0, no ctrl).
    await act(async () => {
      tabTrigger(container, "Subscriptions").dispatchEvent(
        new window.MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          button: 0,
        })
      )
    })
    expect(tabTrigger(container, "Subscriptions").dataset.state).toBe("active")
    expect(tabTrigger(container, "Plans").dataset.state).toBe("inactive")
    expect(
      container.querySelector('[data-testid="subscriptions-table"]')
    ).not.toBeNull()
    expect(container.querySelector('[data-testid="plans-table"]')).toBeNull()
  })

  it("hides the plans tab without VIEW_PLAN_VERSIONS and defaults to subscriptions", async () => {
    await renderTabs({
      canViewPlans: false,
      subscriptionsTable: stubTable(
        "subscriptions-table",
        "Subscriptions table"
      ),
    })
    const triggers = Array.from(
      container.querySelectorAll('[role="tab"]')
    ) as HTMLElement[]
    expect(triggers).toHaveLength(1)
    expect(triggers[0].textContent).toBe("Subscriptions")
    expect(triggers[0].dataset.state).toBe("active")
    expect(
      container.querySelector('[data-testid="subscriptions-table"]')
    ).not.toBeNull()
    expect(container.querySelector('[data-testid="plans-table"]')).toBeNull()
  })
})
