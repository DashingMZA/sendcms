// Phase 16 Wave 6 — Stream C (dashboard pages, AI page & queries).
// Service/validator/pure-function tests for DSH-102, DSH-004, DSH-006,
// DSH-103, DSH-302, DSH-407, DSH-410, AIM-013, AIM-018, SRC-110,
// SRC-124, SRC-214. The dashboard has no component/hook test harness
// (vitest is node-only, no testing-library), so UI wiring is pinned
// with source assertions (the migration-hygiene precedent) and the
// live SSR checks in the stream report; every pure decision the UI
// depends on is unit-tested here.
import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  getDashboardOverview,
  getSubmissionAnalytics,
} from "@sendcms/analytics"
import { getFormEmbedWarnings } from "@sendcms/forms/queries"
import type { FormDetailResponse } from "@sendcms/forms/queries"
import { applyFieldPatch } from "@sendcms/forms/queries"
import { optimisticStatusForAction } from "@sendcms/inbox/queries"
import { resolveInboxListParams } from "@sendcms/inbox/validators"
import { optimisticDomainStatus } from "@sendcms/domains/queries"
import { getUserAiBillingMode, listUserAiKeys } from "@sendcms/ai-settings"
import { listMyTickets } from "@sendcms/support"
import { MyTicketsQuerySchema } from "@sendcms/support/validators"
import { docsUrl } from "../apps/dashboard/lib/app-links"

const mockDb = vi.hoisted(() => ({
  domain: { count: vi.fn(), findMany: vi.fn() },
  form: { count: vi.fn(), findMany: vi.fn() },
  submission: { count: vi.fn(), findMany: vi.fn(), groupBy: vi.fn() },
  supportTicket: { count: vi.fn(), findMany: vi.fn() },
  userAiKey: { findMany: vi.fn() },
  userAiSettings: { findUnique: vi.fn() },
}))
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe("DSH-102 — embed warnings", () => {
  it("warns no-domain for a form with zero linked domains", () => {
    expect(getFormEmbedWarnings({ domainLinks: [], active: true })).toEqual([
      "no-domain",
    ])
  })

  it("warns paused for a paused form with domains linked", () => {
    expect(
      getFormEmbedWarnings({ domainLinks: [{ id: "l1" }], active: false })
    ).toEqual(["paused"])
  })

  it("warns both, no-domain first, for a paused form with no domains", () => {
    expect(getFormEmbedWarnings({ domainLinks: [], active: false })).toEqual([
      "no-domain",
      "paused",
    ])
  })

  it("warns nothing for a linked, active form", () => {
    expect(
      getFormEmbedWarnings({ domainLinks: [{ id: "l1" }], active: true })
    ).toEqual([])
  })

  it("the form-detail Embed section renders both warnings", () => {
    const src = readFileSync(
      "apps/dashboard/app/dashboard/forms/[formId]/form-detail.tsx",
      "utf8"
    )
    expect(src).toContain("getFormEmbedWarnings(form)")
    expect(src).toContain("embedNoDomainWarning")
    expect(src).toContain("embedPausedWarning")
  })

  it("the client component never imports the forms service barrel", () => {
    // The service imports @sendcms/database (Prisma + pg) — a bare
    // "@sendcms/forms" import in this client component broke every
    // dashboard page in dev (Module not found: dns/fs/net/tls).
    // The helper lives in queries.ts; this pins the layering.
    const src = readFileSync(
      "apps/dashboard/app/dashboard/forms/[formId]/form-detail.tsx",
      "utf8"
    )
    expect(src).not.toContain('from "@sendcms/forms"')
    expect(src).toContain('from "@sendcms/forms/queries"')
  })
})

describe("DSH-004 — overview status breakdown", () => {
  beforeEach(() => {
    mockDb.domain.count.mockImplementation(async (args: unknown) =>
      (args as { where?: { status?: string } }).where?.status === "VERIFIED"
        ? 1
        : 1
    )
    mockDb.form.count.mockResolvedValue(1)
    mockDb.submission.count.mockImplementation(
      async (args: { where: { status?: string } }) => {
        switch (args.where.status) {
          case "NEW":
            return 2
          case "SPAM":
            return 1
          case "READ":
            return 3
          case "STARRED":
            return 1
          case "ARCHIVED":
            return 1
          default:
            return 8
        }
      }
    )
    mockDb.submission.findMany.mockResolvedValue([])
  })

  it("counts READ / STARRED / ARCHIVED separately", async () => {
    const overview = await getDashboardOverview("user-1")
    expect(overview.readCount).toBe(3)
    expect(overview.starredCount).toBe(1)
    expect(overview.archivedCount).toBe(1)
    expect(overview.unreadCount).toBe(2)
    expect(overview.spamCount).toBe(1)
    // The five status counts partition the total — nothing is
    // double-counted or lumped under "read".
    expect(
      overview.unreadCount +
        overview.readCount +
        overview.starredCount +
        overview.archivedCount +
        overview.spamCount
    ).toBe(overview.submissionCount)
  })
})

describe("DSH-407 — analytics window alignment", () => {
  const NOW = new Date("2026-11-17T12:00:00.000Z")

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    mockDb.submission.groupBy.mockResolvedValue([])
    mockDb.form.findMany.mockResolvedValue([])
  })

  it("counts a 00:30 day-29 submission in both total and byDay[0]", async () => {
    mockDb.submission.count.mockResolvedValue(1)
    mockDb.submission.findMany.mockResolvedValue([
      { createdAt: new Date("2026-10-19T00:30:00.000Z") },
    ])
    const analytics = await getSubmissionAnalytics("user-1", 30)
    // The window starts at UTC start of day 29 days ago, not at the
    // rolling instant (12:00) — the old bound excluded 00:00–12:00
    // of the first chart day from the total.
    const since = mockDb.submission.count.mock.calls[0][0].where.createdAt
      .gte as Date
    expect(since).toEqual(new Date("2026-10-19T00:00:00.000Z"))
    expect(analytics.total).toBe(1)
    expect(analytics.byDay).toHaveLength(30)
    expect(analytics.byDay[0]).toEqual({ date: "2026-10-19", count: 1 })
    expect(analytics.byDay.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(
      analytics.total
    )
  })

  it("excludes a submission from the day before the window", async () => {
    mockDb.submission.count.mockResolvedValue(0)
    mockDb.submission.findMany.mockResolvedValue([
      { createdAt: new Date("2026-10-18T23:30:00.000Z") },
    ])
    const analytics = await getSubmissionAnalytics("user-1", 30)
    expect(analytics.total).toBe(0)
    expect(analytics.byDay.every((bucket) => bucket.count === 0)).toBe(true)
  })
})

describe("DSH-410 — customer ticket search", () => {
  it("parses ?search= and clamps it like the admin schema", () => {
    expect(MyTicketsQuerySchema.parse({ search: "  refund " })).toEqual({
      page: 1,
      perPage: 20,
      search: "refund",
    })
    expect(
      MyTicketsQuerySchema.safeParse({ search: "x".repeat(201) }).success
    ).toBe(false)
  })

  it("scopes the subject search to the caller's own tickets", async () => {
    mockDb.supportTicket.count.mockResolvedValue(1)
    mockDb.supportTicket.findMany.mockResolvedValue([])
    const page = await listMyTickets("user-1", {
      page: 1,
      perPage: 20,
      search: "refund",
    })
    expect(page.total).toBe(1)
    expect(mockDb.supportTicket.count.mock.calls[0][0].where).toEqual({
      userId: "user-1",
      subject: { contains: "refund", mode: "insensitive" },
    })
  })
})

describe("SRC-124 — inbox canonical redirect", () => {
  it("passes a clean query through with no redirect", () => {
    expect(resolveInboxListParams({})).toEqual({
      params: { tab: "all", page: 1 },
      needsRedirect: false,
      canonicalSearch: "",
    })
    const valid = resolveInboxListParams({ tab: "starred", page: "2" })
    expect(valid.needsRedirect).toBe(false)
    expect(valid.canonicalSearch).toBe("tab=starred&page=2")
    expect(valid.params).toEqual({ tab: "starred", page: 2 })
  })

  it("redirects a bogus tab to the canonical URL", () => {
    const result = resolveInboxListParams({ tab: "bogus" })
    expect(result.params.tab).toBe("all")
    expect(result.needsRedirect).toBe(true)
    expect(result.canonicalSearch).toBe("")
  })

  it("redirects a non-numeric page to the canonical URL", () => {
    const result = resolveInboxListParams({ page: "abc" })
    expect(result.params.page).toBe(1)
    expect(result.needsRedirect).toBe(true)
    expect(result.canonicalSearch).toBe("")
  })

  it("redirects an impossible date instead of dropping it silently", () => {
    const result = resolveInboxListParams({ from: "2026-02-30" })
    expect(result.params.from).toBeUndefined()
    expect(result.needsRedirect).toBe(true)
    expect(result.canonicalSearch).toBe("")
  })

  it("redirects when an unknown key is present, keeping the valid ones", () => {
    const result = resolveInboxListParams({ tab: "unread", bogus: "x" })
    expect(result.needsRedirect).toBe(true)
    expect(result.canonicalSearch).toBe("tab=unread")
  })

  it("redirects a repeated key (array value)", () => {
    const result = resolveInboxListParams({ tab: ["all", "unread"] })
    expect(result.needsRedirect).toBe(true)
  })

  it("keeps valid filters and search in the canonical query", () => {
    const result = resolveInboxListParams({
      tab: "read",
      search: "hello",
      from: "2026-11-01",
    })
    expect(result.needsRedirect).toBe(false)
    expect(result.canonicalSearch).toBe("tab=read&search=hello&from=2026-11-01")
  })
})

describe("SRC-214 — optimistic updates", () => {
  it("maps every inbox action to its target status (or null no-op)", () => {
    expect(optimisticStatusForAction("read", "NEW")).toBe("READ")
    expect(optimisticStatusForAction("read", "READ")).toBeNull()
    expect(optimisticStatusForAction("unread", "STARRED")).toBe("NEW")
    expect(optimisticStatusForAction("star", "READ")).toBe("STARRED")
    expect(optimisticStatusForAction("star", "ARCHIVED")).toBeNull()
    expect(optimisticStatusForAction("unstar", "STARRED")).toBe("READ")
    expect(optimisticStatusForAction("archive", "STARRED")).toBe("ARCHIVED")
    expect(optimisticStatusForAction("restore", "SPAM")).toBe("READ")
    expect(optimisticStatusForAction("restore", "NEW")).toBeNull()
    expect(optimisticStatusForAction("spam", "NEW")).toBe("SPAM")
    expect(optimisticStatusForAction("not-spam", "SPAM")).toBe("READ")
    expect(optimisticStatusForAction("not-spam", "READ")).toBeNull()
  })

  it("maps suspend/reactivate to the service's target statuses", () => {
    expect(optimisticDomainStatus("suspend", new Date())).toBe("SUSPENDED")
    expect(optimisticDomainStatus("suspend", null)).toBe("SUSPENDED")
    expect(optimisticDomainStatus("reactivate", new Date())).toBe("VERIFIED")
    expect(optimisticDomainStatus("reactivate", null)).toBe("PENDING")
  })

  it("patches only the matching field, and never clobbers with undefined", () => {
    const detail = {
      id: "form-1",
      fields: [
        { id: "f1", label: "Name", order: 0 },
        { id: "f2", label: "Email", order: 1 },
      ],
    } as unknown as FormDetailResponse
    const patched = applyFieldPatch(detail, "f1", {
      label: "Full name",
      order: 2,
    })
    expect(patched.fields[0]).toEqual({
      id: "f1",
      label: "Full name",
      order: 2,
    })
    expect(patched.fields[1]).toEqual({ id: "f2", label: "Email", order: 1 })
    // The input object is not mutated.
    expect(detail.fields[0].label).toBe("Name")
  })

  it("the four list mutations use onMutate snapshot-and-rollback", () => {
    for (const [file, hook] of [
      ["packages/modules/inbox/src/queries.ts", "useUpdateSubmissionStatus"],
      ["packages/modules/inbox/src/queries.ts", "useBulkUpdateSubmissions"],
      ["packages/modules/domains/src/queries.ts", "useSetDomainStatus"],
      ["packages/modules/forms/src/queries.ts", "useUpdateField"],
    ] as const) {
      const src = readFileSync(file, "utf8")
      expect(src).toContain(hook)
      expect(src).toContain("onMutate")
      expect(src).toContain("onError")
      expect(src).toContain("onSettled")
    }
  })

  it("billing uses the shared fetcher (no local apiFetch, ApiClientError status kept)", () => {
    const src = readFileSync("packages/modules/billing/src/queries.ts", "utf8")
    expect(src).not.toContain("async function apiFetch")
    expect(src).toContain('import { apiFetch } from "@sendcms/shared"')
  })
})

describe("DSH-302 — saved-key Test refreshes the key list", () => {
  it("useTestAiKey invalidates the keys query on success", () => {
    const src = readFileSync(
      "packages/modules/ai-settings/src/queries.ts",
      "utf8"
    )
    const start = src.indexOf("export function useTestAiKey()")
    const end = src.indexOf("export function useTestBrowserAiKey()")
    const hook = src.slice(start, end)
    expect(hook).toContain("onSuccess")
    expect(hook).toContain(
      "queryClient.invalidateQueries({ queryKey: AI_SETTINGS_KEYS.keys })"
    )
  })
})

describe("DSH-006 — dashboard docs link", () => {
  it("docsUrl is env-driven with the dev docs origin as fallback", () => {
    delete process.env.NEXT_PUBLIC_DOCS_URL
    expect(docsUrl()).toBe("http://localhost:3003")
    vi.stubEnv("NEXT_PUBLIC_DOCS_URL", "https://docs.sendcms.bond/")
    expect(docsUrl()).toBe("https://docs.sendcms.bond")
  })

  it("the sidebar links to the docs origin in a new tab", () => {
    const src = readFileSync(
      "apps/dashboard/components/dashboard/app-sidebar.tsx",
      "utf8"
    )
    expect(src).toContain("docsUrl()")
    expect(src).toContain('target="_blank"')
    expect(src).toContain('t("docs")')
  })
})

describe("DSH-103 — verify refresh on failure", () => {
  it("domain-detail refreshes after every verify result, not only success", () => {
    const src = readFileSync(
      "apps/dashboard/app/dashboard/domains/[domainId]/domain-detail.tsx",
      "utf8"
    )
    expect(src).not.toContain("if (result.verified) router.refresh()")
    const onVerify = src.slice(
      src.indexOf("async function onVerify()"),
      src.indexOf("async function onReverify()")
    )
    expect(onVerify).toContain("router.refresh()")
  })
})

describe("AIM-013 / SRC-110 — AI + billing server fetch", () => {
  it("the AI page's data source returns the user's keys and mode", async () => {
    mockDb.userAiKey.findMany.mockResolvedValue([
      {
        id: "key-1",
        userId: "user-1",
        provider: "OPENAI",
        model: null,
        isEnabled: true,
        keyVersion: 1,
        lastTestedAt: null,
        lastTestStatus: "NEVER_TESTED",
        keyFingerprint: "abcdef1234",
      },
    ])
    mockDb.userAiSettings.findUnique.mockResolvedValue({
      billingMode: "BYOK",
    })
    const [keys, mode] = await Promise.all([
      listUserAiKeys("user-1"),
      getUserAiBillingMode("user-1"),
    ])
    expect(keys).toHaveLength(1)
    expect(keys[0].provider).toBe("openai")
    expect(keys[0].fingerprintLast4).toBe("1234")
    expect(mode).toBe("BYOK")
  })

  it("a missing settings row defaults the mode to PLATFORM server-side", async () => {
    mockDb.userAiSettings.findUnique.mockResolvedValue(null)
    expect(await getUserAiBillingMode("user-1")).toBe("PLATFORM")
  })

  it("the AI page passes server data as initialData", () => {
    const src = readFileSync("apps/dashboard/app/dashboard/ai/page.tsx", "utf8")
    expect(src).toContain("listUserAiKeys(session.user.id)")
    expect(src).toContain("getUserAiBillingMode(session.user.id)")
    expect(src).toContain("initialKeys={initialKeys}")
    expect(src).toContain("initialBillingMode={initialBillingMode}")
  })

  it("the billing page passes the server-fetched subscription as initialData", () => {
    const src = readFileSync(
      // Wave 10 (SRC-111): the page lives in the (overview) group so
      // the billing loading.tsx does not also wrap checkout/.
      "apps/dashboard/app/dashboard/billing/(overview)/page.tsx",
      "utf8"
    )
    expect(src).toContain("getMySubscription(session.user.id)")
    expect(src).toContain("initialSubscription={subscription}")
  })
})

describe("AIM-018 — no guessed billing mode", () => {
  it("AiManager never defaults the displayed mode to PLATFORM", () => {
    const src = readFileSync(
      "apps/dashboard/app/dashboard/ai/ai-manager.tsx",
      "utf8"
    )
    expect(src).not.toContain('?? "PLATFORM"')
    expect(src).toContain("billingModeLoadFailed")
    expect(src).toContain("keysLoadFailed")
  })
})
