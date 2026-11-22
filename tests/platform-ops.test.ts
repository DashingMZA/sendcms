// Platform operations (Admin Control Plane, Phase 7) with a mocked
// Prisma client. The REAL logAudit writer runs against the fake DB
// (only the database, the plans config read, and the i18n loaders
// are stubbed) — so the audit idempotency and FAILED-outcome proofs
// exercise the real writer. No test hits the real DB.
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AdminSession } from "@sendcms/auth"
import * as platformOps from "@sendcms/platform-ops"
import { logAudit } from "@sendcms/security"
import {
  createAnnouncement,
  createFlag,
  executeErasure,
  exportAuditLogs,
  exportTranslations,
  getAuditLog,
  getPlatformHealth,
  getPlatformSubmission,
  getSpamStats,
  getSystemSummary,
  getTranslationCompletion,
  isFeatureEnabled,
  listActiveAnnouncements,
  listAnnouncements,
  listAuditLogs,
  listFlags,
  listPlatformSubmissions,
  removeFlagOverride,
  reviewDeletionRequest,
  setAnnouncementActive,
  setFlag,
  setFlagOverride,
  updateAnnouncement,
  updatePlatformSubmissionStatus,
} from "@sendcms/platform-ops"
import {
  CreateAnnouncementSchema,
  CreateFlagSchema,
  ExecuteErasureSchema,
  ReviewDeletionRequestSchema,
  SetAnnouncementActiveSchema,
  SetFlagOverrideSchema,
  SetFlagSchema,
  UpdatePlatformSubmissionStatusSchema,
} from "@sendcms/platform-ops/validators"
import { requestDeletion } from "@sendcms/admin-users"
import { ApiError } from "@sendcms/api-client"

function makeSession(
  overrides: Partial<AdminSession["user"]> = {}
): AdminSession {
  return {
    user: {
      id: "admin-1",
      name: "Admin",
      email: "admin@csofts.com",
      image: null,
      platformRole: "PLATFORM_OWNER",
      status: "ACTIVE",
      adminRole: null,
      emailVerified: true,
      ...overrides,
    },
    session: { id: "sess-1", userId: "admin-1", expiresAt: new Date() },
  }
}

const ownerSession = makeSession()
const managerSession = makeSession({
  id: "manager-1",
  email: "manager@example.com",
  platformRole: "PLATFORM_USER",
  adminRole: "MANAGER",
})
const supportSession = makeSession({
  id: "support-1",
  email: "support@example.com",
  platformRole: "PLATFORM_USER",
  adminRole: "SUPPORT",
})
const plainSession = makeSession({
  id: "user-9",
  email: "plain@example.com",
  platformRole: "PLATFORM_USER",
  adminRole: null,
})

const now = Date.now()
const daysAgo = (n: number) => new Date(now - n * 24 * 60 * 60 * 1000)
const hoursAgo = (n: number) => new Date(now - n * 60 * 60 * 1000)

const { store, mockDb, mockLoadDomain, mockLoadAppDomain } = vi.hoisted(() => {
  type Row = Record<string, unknown>

  function matchValue(value: unknown, cond: unknown): boolean {
    if (cond === null || cond === undefined) return value === cond
    if (cond instanceof Date) {
      return value instanceof Date && value.getTime() === cond.getTime()
    }
    if (typeof cond !== "object") return value === cond
    const c = cond as Record<string, unknown>
    if ("contains" in c) {
      if (typeof value !== "string") return false
      const needle = String(c.contains)
      return c.mode === "insensitive"
        ? value.toLowerCase().includes(needle.toLowerCase())
        : value.includes(needle)
    }
    if ("equals" in c) return value === c.equals
    if ("in" in c) return (c.in as unknown[]).includes(value)
    if ("gte" in c || "lte" in c || "gt" in c || "lt" in c) {
      const t =
        value instanceof Date
          ? value.getTime()
          : typeof value === "number"
            ? value
            : NaN
      if (Number.isNaN(t)) return false
      if (c.gte !== undefined && !(t >= (c.gte as Date).getTime())) return false
      if (c.lte !== undefined && !(t <= (c.lte as Date).getTime())) return false
      if (c.gt !== undefined && !(t > (c.gt as Date).getTime())) return false
      if (c.lt !== undefined && !(t < (c.lt as Date).getTime())) return false
      return true
    }
    if (typeof value === "object" && value !== null) {
      return Object.entries(c).every(([k, v]) =>
        matchValue((value as Row)[k], v)
      )
    }
    return false
  }

  function matchesWhere(row: Row, where: Row | undefined): boolean {
    if (!where) return true
    return Object.entries(where).every(([key, cond]) => {
      if (key === "AND")
        return (cond as Row[]).every((w) => matchesWhere(row, w))
      if (key === "OR") return (cond as Row[]).some((w) => matchesWhere(row, w))
      return matchValue(row[key], cond)
    })
  }

  function pageOf<T extends Row>(
    rows: T[],
    args: { orderBy?: Row; skip?: number; take?: number } | undefined
  ): T[] {
    let out = [...rows]
    const order = args?.orderBy as Row | undefined
    if (order?.createdAt === "desc")
      out.sort(
        (a, b) =>
          (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime()
      )
    if (order?.createdAt === "asc")
      out.sort(
        (a, b) =>
          (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime()
      )
    if (args?.skip) out = out.slice(args.skip)
    if (args?.take !== undefined) out = out.slice(0, args.take)
    return out
  }

  const store = {
    seq: 0,
    users: new Map<string, Row>(),
    flags: new Map<string, Row>(),
    overrides: new Map<string, Row>(),
    announcements: new Map<string, Row>(),
    auditLogs: [] as Row[],
    deletionRequests: new Map<string, Row>(),
    submissions: [] as Row[],
    submissionEvents: [] as Row[],
    forms: new Map<string, Row>(),
    domains: new Map<string, Row>(),
    apiKeys: [] as Row[],
    sessions: [] as Row[],
    accounts: [] as Row[],
    userAiKeys: [] as Row[],
    userAiSettings: [] as Row[],
    mcpUserSettings: [] as Row[],
    entitlementOverrides: [] as Row[],
    adminNotes: [] as Row[],
    subscriptions: [] as Row[],
    usageLedger: [] as Row[],
    aiUsageRecords: [] as Row[],
    mcpUsageRecords: [] as Row[],
    aiDailyUsage: [] as Row[],
    emailJobs: [] as Row[],
    aiProviderConfigs: [] as Row[],
    mcpSettings: null as Row | null,
  }

  const nextId = () => `id-${++store.seq}`

  const mockDb = {
    user: {
      findUnique: vi.fn(async (args: Row) => {
        const row = [...store.users.values()].find((u) =>
          matchesWhere(u, args.where as Row)
        )
        return row ? { ...row } : null
      }),
      findMany: vi.fn(async (args: Row) => {
        const rows = [...store.users.values()].filter((u) =>
          matchesWhere(u, args.where as Row)
        )
        return pageOf(rows, args)
      }),
      count: vi.fn(async (args: Row = {}) => {
        return [...store.users.values()].filter((u) =>
          matchesWhere(u, args.where as Row)
        ).length
      }),
      update: vi.fn(async (args: Row) => {
        const row = [...store.users.values()].find((u) =>
          matchesWhere(u, args.where as Row)
        )
        if (!row) throw new Error("Record not found")
        for (const [k, v] of Object.entries(args.data as Row)) {
          if (v !== undefined) row[k] = v
        }
        return { ...row }
      }),
    },
    featureFlag: {
      findMany: vi.fn(async (args: Row = {}) => {
        const rows = [...store.flags.values()].filter((f) =>
          matchesWhere(f, args.where as Row)
        )
        return pageOf(rows, args)
      }),
      findUnique: vi.fn(async (args: Row) => {
        const row = [...store.flags.values()].find((f) =>
          matchesWhere(f, args.where as Row)
        )
        return row ? { ...row } : null
      }),
      create: vi.fn(async (args: Row) => {
        const row: Row = {
          id: nextId(),
          createdAt: new Date(),
          updatedAt: new Date(),
          // The schema default: a new flag is off.
          isEnabled: false,
          ...(args.data as Row),
        }
        store.flags.set(row.key as string, row)
        return { ...row }
      }),
      update: vi.fn(async (args: Row) => {
        const row = [...store.flags.values()].find((f) =>
          matchesWhere(f, args.where as Row)
        )
        if (!row) throw new Error("Record not found")
        for (const [k, v] of Object.entries(args.data as Row)) {
          if (v !== undefined) row[k] = v
        }
        row.updatedAt = new Date()
        return { ...row }
      }),
    },
    featureFlagOverride: {
      findMany: vi.fn(async (args: Row = {}) => {
        const rows = [...store.overrides.values()]
          .filter((o) => matchesWhere(o, args.where as Row))
          .map((o) => ({
            ...o,
            user: store.users.get(o.userId as string) ?? null,
          }))
        return pageOf(rows, args)
      }),
      findUnique: vi.fn(async (args: Row) => {
        // Prisma's composite-unique where is
        // { flagId_userId: { flagId, userId } } — match the two
        // fields, not a nested object on the row.
        const w = (args.where as Row).flagId_userId as Row
        const row = [...store.overrides.values()].find(
          (o) => o.flagId === w.flagId && o.userId === w.userId
        )
        return row ? { ...row } : null
      }),
      upsert: vi.fn(async (args: Row) => {
        const w = (args.where as Row).flagId_userId as Row
        const key = `${w.flagId}:${w.userId}`
        const existing = store.overrides.get(key)
        if (existing) {
          for (const [k, v] of Object.entries(args.update as Row)) {
            if (v !== undefined) existing[k] = v
          }
          existing.updatedAt = new Date()
          return {
            ...existing,
            user: store.users.get(existing.userId as string) ?? null,
          }
        }
        const row: Row = {
          id: nextId(),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...(args.create as Row),
        }
        store.overrides.set(key, row)
        return {
          ...row,
          user: store.users.get(row.userId as string) ?? null,
        }
      }),
      delete: vi.fn(async (args: Row) => {
        const w = (args.where as Row).flagId_userId as Row
        const key = `${w.flagId}:${w.userId}`
        const row = store.overrides.get(key)
        if (!row) throw new Error("Record not found")
        store.overrides.delete(key)
        return { ...row }
      }),
      deleteMany: vi.fn(async (args: Row = {}) => {
        let n = 0
        for (const [k, v] of [...store.overrides.entries()]) {
          if (matchesWhere(v, args.where as Row)) {
            store.overrides.delete(k)
            n++
          }
        }
        return { count: n }
      }),
    },
    announcement: {
      findMany: vi.fn(async (args: Row = {}) => {
        const rows = [...store.announcements.values()]
          .filter((a) => matchesWhere(a, args.where as Row))
          .map((a) => ({
            ...a,
            createdBy: store.users.get(a.createdById as string) ?? null,
          }))
        return pageOf(rows, args)
      }),
      findUnique: vi.fn(async (args: Row) => {
        const row = [...store.announcements.values()].find((a) =>
          matchesWhere(a, args.where as Row)
        )
        return row
          ? {
              ...row,
              createdBy: store.users.get(row.createdById as string) ?? null,
            }
          : null
      }),
      count: vi.fn(async (args: Row = {}) => {
        return [...store.announcements.values()].filter((a) =>
          matchesWhere(a, args.where as Row)
        ).length
      }),
      create: vi.fn(async (args: Row) => {
        const row: Row = {
          id: nextId(),
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...(args.data as Row),
          // Prisma stores NULL for an omitted optional window bound;
          // the service passes `undefined` when no bound was given,
          // so normalize here or the active-window matcher (which
          // tests `startsAt: null`) would wrongly exclude the row.
          startsAt: (args.data as Row).startsAt ?? null,
          endsAt: (args.data as Row).endsAt ?? null,
        }
        store.announcements.set(row.id as string, row)
        return {
          ...row,
          createdBy: store.users.get(row.createdById as string) ?? null,
        }
      }),
      update: vi.fn(async (args: Row) => {
        const row = [...store.announcements.values()].find((a) =>
          matchesWhere(a, args.where as Row)
        )
        if (!row) throw new Error("Record not found")
        for (const [k, v] of Object.entries(args.data as Row)) {
          if (v !== undefined) row[k] = v
        }
        row.updatedAt = new Date()
        return {
          ...row,
          createdBy: store.users.get(row.createdById as string) ?? null,
        }
      }),
    },
    auditLog: {
      findMany: vi.fn(async (args: Row = {}) => {
        const rows = store.auditLogs
          .filter((l) => matchesWhere(l, args.where as Row))
          .map((l) => ({
            ...l,
            user: store.users.get(l.userId as string) ?? null,
          }))
        return pageOf(rows, args)
      }),
      findUnique: vi.fn(async (args: Row) => {
        const row = store.auditLogs.find((l) =>
          matchesWhere(l, args.where as Row)
        )
        return row
          ? { ...row, user: store.users.get(row.userId as string) ?? null }
          : null
      }),
      findFirst: vi.fn(async (args: Row = {}) => {
        const row = store.auditLogs.find((l) =>
          matchesWhere(l, args.where as Row)
        )
        return row ? { ...row } : null
      }),
      count: vi.fn(async (args: Row = {}) => {
        return store.auditLogs.filter((l) => matchesWhere(l, args.where as Row))
          .length
      }),
      create: vi.fn(async (args: Row) => {
        const row = {
          id: nextId(),
          createdAt: new Date(),
          outcome: "SUCCESS",
          ...(args.data as Row),
        }
        // Prisma treats `undefined` as "not set", so the schema
        // default (SUCCESS) applies — mirror that here instead of
        // letting the spread overwrite the default with undefined.
        if (row.outcome === undefined) row.outcome = "SUCCESS"
        store.auditLogs.push(row)
        return { ...row }
      }),
    },
    deletionRequest: {
      findMany: vi.fn(async (args: Row = {}) => {
        const rows = [...store.deletionRequests.values()]
          .filter((r) => matchesWhere(r, args.where as Row))
          .map((r) => ({
            ...r,
            user: store.users.get(r.userId as string) ?? null,
            reviewedBy: store.users.get(r.reviewedById as string) ?? null,
          }))
        return pageOf(rows, args)
      }),
      findUnique: vi.fn(async (args: Row) => {
        const row = [...store.deletionRequests.values()].find((r) =>
          matchesWhere(r, args.where as Row)
        )
        return row
          ? {
              ...row,
              user: store.users.get(row.userId as string) ?? null,
              reviewedBy: store.users.get(row.reviewedById as string) ?? null,
            }
          : null
      }),
      findFirst: vi.fn(async (args: Row = {}) => {
        const row = [...store.deletionRequests.values()].find((r) =>
          matchesWhere(r, args.where as Row)
        )
        return row ? { ...row } : null
      }),
      count: vi.fn(async (args: Row = {}) => {
        return [...store.deletionRequests.values()].filter((r) =>
          matchesWhere(r, args.where as Row)
        ).length
      }),
      create: vi.fn(async (args: Row) => {
        const row = {
          id: nextId(),
          status: "REQUESTED",
          reviewedById: null,
          reviewedAt: null,
          completedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...(args.data as Row),
        }
        store.deletionRequests.set(row.id as string, row)
        return { ...row }
      }),
      update: vi.fn(async (args: Row) => {
        const row = [...store.deletionRequests.values()].find((r) =>
          matchesWhere(r, args.where as Row)
        )
        if (!row) throw new Error("Record not found")
        for (const [k, v] of Object.entries(args.data as Row)) {
          if (v !== undefined) row[k] = v
        }
        row.updatedAt = new Date()
        return {
          ...row,
          user: store.users.get(row.userId as string) ?? null,
          reviewedBy: store.users.get(row.reviewedById as string) ?? null,
        }
      }),
    },
    // Phase 9: the gated actions (deletion approve/erase) call
    // requireStepUp, which reads the latest unexpired verification.
    // These tests run as a verified admin.
    stepUpVerification: {
      findFirst: vi.fn(async () => ({
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      })),
    },
    submission: {
      findMany: vi.fn(async (args: Row = {}) => {
        const rows = store.submissions
          .filter((s) => matchesWhere(s, args.where as Row))
          .map((s) => {
            if (!args.select) return { ...s }
            // The list is metadata only: drop `data` (may hold PII)
            // from the returned row, like the real select does.
            const meta = { ...s }
            delete meta.data
            return meta
          })
        return pageOf(rows, args)
      }),
      findFirst: vi.fn(async (args: Row = {}) => {
        const row = store.submissions.find((s) =>
          matchesWhere(s, args.where as Row)
        )
        return row ? { ...row } : null
      }),
      findUnique: vi.fn(async (args: Row = {}) => {
        const row = store.submissions.find((s) =>
          matchesWhere(s, args.where as Row)
        )
        if (!row) return null
        const form = store.forms.get(row.formId as string)
        return {
          ...row,
          form: form
            ? {
                ...form,
                owner: store.users.get(form.ownerId as string) ?? null,
              }
            : null,
          events: store.submissionEvents
            .filter((e) => e.submissionId === row.id)
            .map((e) => ({
              ...e,
              actor: store.users.get(e.actorId as string) ?? null,
            })),
        }
      }),
      count: vi.fn(async (args: Row = {}) => {
        return store.submissions.filter((s) =>
          matchesWhere(s, args.where as Row)
        ).length
      }),
      groupBy: vi.fn(async (args: Row) => {
        const rows = store.submissions.filter((s) =>
          matchesWhere(s, args.where as Row)
        )
        const by = (args.by as string[])[0]
        const groups = new Map<string, number>()
        for (const r of rows) {
          const k = String(r[by])
          groups.set(k, (groups.get(k) ?? 0) + 1)
        }
        let out = [...groups.entries()].map(([k, n]) => ({
          [by]: k,
          _count: { _all: n },
        }))
        const order = (args.orderBy as Row | undefined)?._count as
          Row | undefined
        if (order) {
          out = out.sort((a, b) => b._count._all - a._count._all)
        }
        if (args.take !== undefined) out = out.slice(0, args.take as number)
        return out
      }),
      update: vi.fn(async (args: Row) => {
        const row = store.submissions.find((s) =>
          matchesWhere(s, args.where as Row)
        )
        if (!row) throw new Error("Record not found")
        for (const [k, v] of Object.entries(args.data as Row)) {
          if (v !== undefined) row[k] = v
        }
        return { ...row }
      }),
    },
    submissionEvent: {
      create: vi.fn(async (args: Row) => {
        const row = {
          id: nextId(),
          createdAt: new Date(),
          ...(args.data as Row),
        }
        store.submissionEvents.push(row)
        return { ...row }
      }),
    },
    form: {
      count: vi.fn(async (args: Row = {}) => {
        return [...store.forms.values()].filter((f) =>
          matchesWhere(f, args.where as Row)
        ).length
      }),
      findMany: vi.fn(async (args: Row = {}) => {
        const rows = [...store.forms.values()]
          .filter((f) => matchesWhere(f, args.where as Row))
          .map((f) => ({
            ...f,
            owner: store.users.get(f.ownerId as string) ?? null,
          }))
        return pageOf(rows, args)
      }),
      deleteMany: vi.fn(async (args: Row = {}) => {
        let n = 0
        for (const [k, v] of [...store.forms.entries()]) {
          if (matchesWhere(v, args.where as Row)) {
            store.forms.delete(k)
            n++
          }
        }
        return { count: n }
      }),
    },
    domain: {
      count: vi.fn(async (args: Row = {}) => {
        return [...store.domains.values()].filter((d) =>
          matchesWhere(d, args.where as Row)
        ).length
      }),
      findMany: vi.fn(async (args: Row = {}) => {
        return [...store.domains.values()].filter((d) =>
          matchesWhere(d, args.where as Row)
        )
      }),
      deleteMany: vi.fn(async (args: Row = {}) => {
        let n = 0
        for (const [k, v] of [...store.domains.entries()]) {
          if (matchesWhere(v, args.where as Row)) {
            store.domains.delete(k)
            n++
          }
        }
        return { count: n }
      }),
    },
    emailJob: {
      count: vi.fn(async (args: Row = {}) => {
        return store.emailJobs.filter((j) => matchesWhere(j, args.where as Row))
          .length
      }),
      findFirst: vi.fn(async (args: Row = {}) => {
        const rows = store.emailJobs.filter((j) =>
          matchesWhere(j, args.where as Row)
        )
        return pageOf(rows, args)[0] ?? null
      }),
    },
    aiDailyUsage: {
      aggregate: vi.fn(async (args: Row = {}) => {
        const rows = store.aiDailyUsage.filter((u) =>
          matchesWhere(u, args.where as Row)
        )
        return {
          _sum: { calls: rows.reduce((n, r) => n + (r.calls as number), 0) },
        }
      }),
    },
    mcpUsageRecord: {
      groupBy: vi.fn(async (args: Row) => {
        const rows = store.mcpUsageRecords.filter((r) =>
          matchesWhere(r, args.where as Row)
        )
        const by = (args.by as string[])[0]
        const groups = new Map<string, number>()
        for (const r of rows) {
          const k = String(r[by])
          groups.set(k, (groups.get(k) ?? 0) + 1)
        }
        return [...groups.entries()].map(([k, n]) => ({
          [by]: k,
          _count: { _all: n },
        }))
      }),
      count: vi.fn(async (args: Row = {}) => {
        return store.mcpUsageRecords.filter((r) =>
          matchesWhere(r, args.where as Row)
        ).length
      }),
    },
    mcpSettings: {
      findFirst: vi.fn(async () => {
        return store.mcpSettings ? { ...store.mcpSettings } : null
      }),
    },
    aiProviderConfig: {
      count: vi.fn(async (args: Row = {}) => {
        return store.aiProviderConfigs.filter((c) =>
          matchesWhere(c, args.where as Row)
        ).length
      }),
    },
    apiKey: {
      findMany: vi.fn(async (args: Row = {}) => {
        return store.apiKeys.filter((k) => matchesWhere(k, args.where as Row))
      }),
      updateMany: vi.fn(async (args: Row = {}) => {
        let n = 0
        for (const k of store.apiKeys) {
          if (matchesWhere(k, args.where as Row)) {
            for (const [f, v] of Object.entries(args.data as Row)) {
              if (v !== undefined) k[f] = v
            }
            n++
          }
        }
        return { count: n }
      }),
    },
    session: {
      deleteMany: vi.fn(async (args: Row = {}) => {
        const before = store.sessions.length
        store.sessions = store.sessions.filter(
          (s) => !matchesWhere(s, args.where as Row)
        )
        return { count: before - store.sessions.length }
      }),
    },
    account: {
      deleteMany: vi.fn(async (args: Row = {}) => {
        const before = store.accounts.length
        store.accounts = store.accounts.filter(
          (a) => !matchesWhere(a, args.where as Row)
        )
        return { count: before - store.accounts.length }
      }),
    },
    userAiKey: {
      deleteMany: vi.fn(async (args: Row = {}) => {
        const before = store.userAiKeys.length
        store.userAiKeys = store.userAiKeys.filter(
          (k) => !matchesWhere(k, args.where as Row)
        )
        return { count: before - store.userAiKeys.length }
      }),
    },
    userAiSettings: {
      deleteMany: vi.fn(async (args: Row = {}) => {
        const before = store.userAiSettings.length
        store.userAiSettings = store.userAiSettings.filter(
          (s) => !matchesWhere(s, args.where as Row)
        )
        return { count: before - store.userAiSettings.length }
      }),
    },
    mcpUserSettings: {
      deleteMany: vi.fn(async (args: Row = {}) => {
        const before = store.mcpUserSettings.length
        store.mcpUserSettings = store.mcpUserSettings.filter(
          (s) => !matchesWhere(s, args.where as Row)
        )
        return { count: before - store.mcpUserSettings.length }
      }),
    },
    entitlementOverride: {
      deleteMany: vi.fn(async (args: Row = {}) => {
        const before = store.entitlementOverrides.length
        store.entitlementOverrides = store.entitlementOverrides.filter(
          (o) => !matchesWhere(o, args.where as Row)
        )
        return { count: before - store.entitlementOverrides.length }
      }),
    },
    adminNote: {
      deleteMany: vi.fn(async (args: Row = {}) => {
        const before = store.adminNotes.length
        store.adminNotes = store.adminNotes.filter(
          (n) => !matchesWhere(n, args.where as Row)
        )
        return { count: before - store.adminNotes.length }
      }),
    },
    $transaction: vi.fn(async (arg: unknown) => {
      if (typeof arg === "function") {
        return (arg as (tx: typeof mockDb) => unknown)(mockDb)
      }
      if (Array.isArray(arg)) return Promise.all(arg)
      return arg
    }),
    $queryRaw: vi.fn(async (arg: unknown) => {
      // Called two ways: as a template tag (pingDatabase:
      // $queryRaw`SELECT 1` — first arg is a TemplateStringsArray)
      // and with a Prisma.sql object (getSystemSummary: the Sql
      // instance carries the query in its `.sql` string).
      let sql = ""
      if (typeof arg === "string") sql = arg
      else if (Array.isArray(arg)) sql = arg.join("")
      else if (
        arg &&
        typeof arg === "object" &&
        typeof (arg as Row).sql === "string"
      )
        sql = (arg as Row).sql as string
      else sql = String(arg)
      if (sql.includes("version()"))
        return [{ version: "PostgreSQL 16.1 on x86_64-pc-linux-gnu" }]
      return [{ "?column?": 1 }]
    }),
  }

  const mockLoadDomain = vi.fn()
  const mockLoadAppDomain = vi.fn()

  return { store, mockDb, mockLoadDomain, mockLoadAppDomain }
})

vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return {
    ...actual,
    db: mockDb,
    // The real pingDatabase closes over the REAL Prisma client from
    // ./client (not the mocked `db` export), so it would try a live
    // connection and report "disconnected" in tests. The fake DB is
    // the connection under test — the ping is always up here.
    pingDatabase: async () => ({
      status: "ok" as const,
      database: "connected" as const,
      latencyMs: 0,
      timestamp: new Date().toISOString(),
    }),
  }
})
vi.mock("@sendcms/plans", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/plans")>()
  return { ...actual, readPlatformConfig: () => ({ emergency: false }) }
})
vi.mock("@sendcms/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/i18n")>()
  return {
    ...actual,
    loadLocaleDomain: mockLoadDomain,
    loadLocaleAppDomain: mockLoadAppDomain,
  }
})

// ─── Seed ───────────────────────────────────────────────────────────────

function seedUser(
  id: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const user = {
    id,
    name: `User ${id}`,
    email: `${id}@example.com`,
    image: null,
    platformRole: "PLATFORM_USER",
    adminRole: null,
    status: "ACTIVE",
    statusReason: null,
    emailVerified: true,
    locale: "en",
    createdAt: daysAgo(30),
    updatedAt: daysAgo(1),
    deletionRequestedAt: null,
    deletionRequestReason: null,
    deletionCompletedAt: null,
    ...overrides,
  }
  store.users.set(id, user)
  return user
}

function seedSubmission(
  id: string,
  formId: string,
  status: string,
  createdAt: Date,
  originDomain = "sendcms.bond"
): void {
  const form = store.forms.get(formId)!
  const owner = store.users.get(form.ownerId as string)!
  store.submissions.push({
    id,
    status,
    originDomain,
    pageUrl: "https://sendcms.bond/demo/contact-us",
    data: { name: "Visitor", email: "visitor@example.com", message: "Hi" },
    createdAt,
    updatedAt: createdAt,
    formId,
    form: {
      id: form.id,
      name: form.name,
      ownerId: form.ownerId,
      owner: { id: owner.id, name: owner.name, email: owner.email },
    },
  })
}

function seedAudit(id: string, overrides: Record<string, unknown>): void {
  store.auditLogs.push({
    id,
    action: "UPDATE",
    resourceType: "USER",
    resourceId: "user-1",
    detail: { event: "test" },
    ipAddress: null,
    reason: null,
    correlationId: null,
    outcome: "SUCCESS",
    createdAt: new Date(),
    userId: "admin-1",
    ...overrides,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockLoadDomain.mockReset()
  mockLoadAppDomain.mockReset()
  store.seq = 0
  for (const map of [
    store.users,
    store.flags,
    store.overrides,
    store.announcements,
    store.deletionRequests,
    store.forms,
    store.domains,
  ])
    map.clear()
  for (const arr of [
    store.auditLogs,
    store.submissions,
    store.submissionEvents,
    store.apiKeys,
    store.sessions,
    store.accounts,
    store.userAiKeys,
    store.userAiSettings,
    store.mcpUserSettings,
    store.entitlementOverrides,
    store.adminNotes,
    store.subscriptions,
    store.usageLedger,
    store.aiUsageRecords,
    store.mcpUsageRecords,
    store.aiDailyUsage,
    store.emailJobs,
    store.aiProviderConfigs,
  ])
    arr.length = 0
  store.mcpSettings = { globalEnabled: true }

  seedUser("admin-1", {
    name: "Admin",
    email: "admin@csofts.com",
    platformRole: "PLATFORM_OWNER",
  })
  seedUser("manager-1", {
    name: "Manager",
    email: "manager@example.com",
    adminRole: "MANAGER",
  })
  seedUser("support-1", {
    name: "Support",
    email: "support@example.com",
    adminRole: "SUPPORT",
  })
  seedUser("user-9", { name: "Plain", email: "plain@example.com" })
  seedUser("user-1", { name: "Customer One", email: "customer1@example.com" })
  seedUser("user-2", { name: "Customer Two", email: "customer2@example.com" })
  seedUser("user-3", {
    name: "Suspended",
    email: "suspended@example.com",
    status: "SUSPENDED",
  })

  store.forms.set("form-1", {
    id: "form-1",
    name: "Contact us",
    ownerId: "user-1",
  })
  store.forms.set("form-2", {
    id: "form-2",
    name: "Support",
    ownerId: "user-2",
  })
  store.domains.set("domain-1", { id: "domain-1", ownerId: "user-1" })
  store.domains.set("domain-2", { id: "domain-2", ownerId: "user-2" })

  seedSubmission("sub-1", "form-1", "NEW", new Date())
  seedSubmission("sub-2", "form-1", "SPAM", new Date())
  seedSubmission("sub-3", "form-1", "SPAM", daysAgo(2))
  seedSubmission("sub-4", "form-2", "READ", new Date())
  seedSubmission("sub-5", "form-2", "ARCHIVED", daysAgo(5))
  seedSubmission("sub-6", "form-1", "NEW", daysAgo(40))

  seedAudit("audit-1", {
    userId: "admin-1",
    action: "UPDATE",
    resourceType: "USER",
    resourceId: "user-1",
    correlationId: "corr-1",
    createdAt: new Date(),
  })
  seedAudit("audit-2", {
    userId: "manager-1",
    action: "CREATE",
    resourceType: "PLAN",
    resourceId: "plan-1",
    createdAt: daysAgo(1),
  })
  seedAudit("audit-3", {
    userId: "admin-1",
    action: "DELETE",
    resourceType: "API_KEY",
    resourceId: "key-1",
    outcome: "FAILED",
    correlationId: "corr-2",
    createdAt: daysAgo(2),
  })
  seedAudit("audit-4", {
    userId: "admin-1",
    action: "UPDATE",
    resourceType: "SUBMISSION",
    resourceId: "sub-2",
    createdAt: new Date(),
  })

  store.flags.set("ai-features", {
    id: "flag-1",
    key: "ai-features",
    name: "AI features",
    description: "Platform AI",
    isEnabled: true,
    createdAt: daysAgo(10),
    updatedAt: daysAgo(10),
  })
  store.flags.set("beta-ui", {
    id: "flag-2",
    key: "beta-ui",
    name: "Beta UI",
    description: null,
    isEnabled: false,
    createdAt: daysAgo(10),
    updatedAt: daysAgo(10),
  })
  store.overrides.set("flag-1:user-1", {
    id: "ovr-1",
    flagId: "flag-1",
    userId: "user-1",
    isEnabled: false,
    reason: "Opted out",
    adminId: "admin-1",
    createdAt: daysAgo(2),
    updatedAt: daysAgo(2),
  })

  const tomorrow = new Date(now + 24 * 60 * 60 * 1000)
  const yesterday = daysAgo(1)
  store.announcements.set("ann-1", {
    id: "ann-1",
    title: "Welcome",
    body: "Hello everyone",
    audience: "ALL",
    isActive: true,
    startsAt: null,
    endsAt: null,
    createdById: "admin-1",
    createdAt: daysAgo(3),
    updatedAt: daysAgo(3),
  })
  store.announcements.set("ann-2", {
    id: "ann-2",
    title: "Admins only",
    body: "Internal",
    audience: "ADMIN_ONLY",
    isActive: true,
    startsAt: null,
    endsAt: null,
    createdById: "admin-1",
    createdAt: daysAgo(3),
    updatedAt: daysAgo(3),
  })
  store.announcements.set("ann-3", {
    id: "ann-3",
    title: "Off",
    body: "Deactivated",
    audience: "ALL",
    isActive: false,
    startsAt: null,
    endsAt: null,
    createdById: "admin-1",
    createdAt: daysAgo(3),
    updatedAt: daysAgo(3),
  })
  store.announcements.set("ann-4", {
    id: "ann-4",
    title: "Future",
    body: "Not yet",
    audience: "ALL",
    isActive: true,
    startsAt: tomorrow,
    endsAt: null,
    createdById: "admin-1",
    createdAt: daysAgo(3),
    updatedAt: daysAgo(3),
  })
  store.announcements.set("ann-5", {
    id: "ann-5",
    title: "Expired",
    body: "Over",
    audience: "ALL",
    isActive: true,
    startsAt: null,
    endsAt: yesterday,
    createdById: "admin-1",
    createdAt: daysAgo(3),
    updatedAt: daysAgo(3),
  })

  store.deletionRequests.set("dr-1", {
    id: "dr-1",
    userId: "user-1",
    status: "REQUESTED",
    reason: "Leaving",
    reviewedById: null,
    reviewedAt: null,
    completedAt: null,
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
  })
  store.deletionRequests.set("dr-2", {
    id: "dr-2",
    userId: "user-2",
    status: "APPROVED",
    reason: "GDPR request",
    reviewedById: "admin-1",
    reviewedAt: hoursAgo(2),
    completedAt: null,
    createdAt: daysAgo(2),
    updatedAt: hoursAgo(2),
  })

  store.apiKeys.push(
    { id: "key-1", userId: "user-1", revokedAt: null },
    { id: "key-2", userId: "user-1", revokedAt: daysAgo(5) },
    { id: "key-3", userId: "user-2", revokedAt: null }
  )
  store.sessions.push(
    { id: "sess-a", userId: "user-1" },
    { id: "sess-b", userId: "user-1" },
    { id: "sess-c", userId: "user-2" }
  )
  store.accounts.push({ id: "acc-1", userId: "user-1" })
  store.userAiKeys.push({ id: "byok-1", userId: "user-1" })
  store.userAiSettings.push({ id: "ais-1", userId: "user-1" })
  store.mcpUserSettings.push({ id: "mcp-1", userId: "user-1" })
  store.entitlementOverrides.push({ id: "ent-1", userId: "user-1" })
  store.adminNotes.push({ id: "note-1", userId: "user-1" })
  store.subscriptions.push({ id: "sub-1", userId: "user-1" })
  store.usageLedger.push({ id: "led-1", userId: "user-1" })
  store.aiUsageRecords.push({ id: "aiu-1", userId: "user-1" })

  const todayStart = new Date()
  todayStart.setUTCHours(0, 0, 0, 0)
  store.mcpUsageRecords.push(
    {
      id: "mcp-1",
      userId: "user-1",
      apiKeyId: "key-1",
      tool: "domains.list",
      status: "SUCCESS",
      createdAt: hoursAgo(1),
    },
    {
      id: "mcp-2",
      userId: "user-1",
      apiKeyId: "key-1",
      tool: "forms.create",
      status: "SUCCESS",
      createdAt: hoursAgo(2),
    },
    {
      id: "mcp-3",
      userId: "user-2",
      apiKeyId: "key-3",
      tool: "domains.list",
      status: "FAILED",
      createdAt: hoursAgo(3),
    },
    {
      id: "mcp-4",
      userId: "user-1",
      apiKeyId: "key-1",
      tool: "domains.list",
      status: "FAILED",
      createdAt: daysAgo(40),
    }
  )
  store.aiDailyUsage.push(
    { id: "adu-1", formId: "form-1", date: todayStart, calls: 40 },
    { id: "adu-2", formId: "form-2", date: daysAgo(1), calls: 10 }
  )
  store.emailJobs.push(
    { id: "job-1", status: "PENDING", createdAt: hoursAgo(3) },
    { id: "job-2", status: "PENDING", createdAt: hoursAgo(0.5) },
    { id: "job-3", status: "SENT", createdAt: daysAgo(1) }
  )
  store.aiProviderConfigs.push(
    { id: "apc-1", isEnabled: true },
    { id: "apc-2", isEnabled: true },
    { id: "apc-3", isEnabled: true },
    { id: "apc-4", isEnabled: false },
    { id: "apc-5", isEnabled: false }
  )
})

// ─── Feature flags ────────────────────────────────────────────────────

describe("feature flags", () => {
  it("precedence: per-user override beats the global flag", async () => {
    // ai-features is globally ON, but user-1 has an override OFF.
    expect(await isFeatureEnabled("ai-features", "user-1")).toBe(false)
    expect(await isFeatureEnabled("ai-features", "user-2")).toBe(true)
    expect(await isFeatureEnabled("ai-features")).toBe(true)
  })

  it("unknown key is off, and a disabled flag stays off", async () => {
    expect(await isFeatureEnabled("no-such-flag", "user-1")).toBe(false)
    expect(await isFeatureEnabled("beta-ui", "user-1")).toBe(false)
  })

  it("creates a flag, toggles it, and audits with old/new", async () => {
    const created = await createFlag(ownerSession, {
      key: "new-dash",
      name: "New dashboard",
    })
    expect(created.isEnabled).toBe(false)
    const toggled = await setFlag(ownerSession, "new-dash", {
      isEnabled: true,
      reason: "Rollout",
    })
    expect(toggled.isEnabled).toBe(true)
    const audit = store.auditLogs.find(
      (l) => l.resourceId === "new-dash" && l.action === "UPDATE"
    )
    expect(audit?.detail).toMatchObject({
      event: "flag-toggled",
      reason: "Rollout",
      oldIsEnabled: false,
      newIsEnabled: true,
    })
  })

  it("rejects a toggle without a reason (schema) and a duplicate key", async () => {
    expect(() => SetFlagSchema.parse({ isEnabled: true, reason: "" })).toThrow()
    expect(() =>
      SetFlagOverrideSchema.parse({ isEnabled: true, reason: "  " })
    ).toThrow()
    await expect(
      createFlag(ownerSession, { key: "ai-features", name: "Dupe" })
    ).rejects.toThrowError(ApiError)
    // The key regex lives in the Zod schema (the route validates
    // it); the service itself takes the key as given, so the bad
    // key is proven at the schema level, not the service level.
    expect(() =>
      CreateFlagSchema.parse({ key: "Bad Key!", name: "Bad" })
    ).toThrow()
  })

  it("override set/remove falls back to the global flag", async () => {
    await setFlagOverride(ownerSession, "beta-ui", "user-2", {
      isEnabled: true,
      reason: "Beta tester",
    })
    expect(await isFeatureEnabled("beta-ui", "user-2")).toBe(true)
    await removeFlagOverride(ownerSession, "beta-ui", "user-2")
    expect(await isFeatureEnabled("beta-ui", "user-2")).toBe(false)
    await expect(
      removeFlagOverride(ownerSession, "beta-ui", "user-2")
    ).rejects.toThrowError(ApiError)
  })

  it("forbids flag writes for MANAGER and SUPPORT", async () => {
    await expect(
      setFlag(managerSession, "beta-ui", {
        isEnabled: true,
        reason: "No",
      })
    ).rejects.toThrowError(ApiError)
    await expect(listFlags(supportSession)).rejects.toThrowError(ApiError)
  })
})

// ─── Announcements ────────────────────────────────────────────────────

describe("announcements", () => {
  it("active window: only live ALL announcements for customers", async () => {
    const { announcements } = await listActiveAnnouncements(false)
    expect(announcements.map((a) => a.id)).toEqual(["ann-1"])
  })

  it("admins also see ADMIN_ONLY announcements", async () => {
    const { announcements } = await listActiveAnnouncements(true)
    expect(announcements.map((a) => a.id).sort()).toEqual(["ann-1", "ann-2"])
  })

  it("rejects an inverted window and creates + updates + deactivates", async () => {
    expect(() =>
      CreateAnnouncementSchema.parse({
        title: "T",
        body: "B",
        startsAt: new Date(now + 86400000).toISOString(),
        endsAt: new Date(now).toISOString(),
      })
    ).toThrow()
    const created = await createAnnouncement(ownerSession, {
      title: "Maintenance",
      body: "Down Sunday",
      audience: "ALL",
    })
    expect(created.isActive).toBe(true)
    const updated = await updateAnnouncement(ownerSession, created.id, {
      title: "Maintenance window",
    })
    expect(updated.title).toBe("Maintenance window")
    const deactivated = await setAnnouncementActive(ownerSession, created.id, {
      isActive: false,
      reason: "Done",
    })
    expect(deactivated.isActive).toBe(false)
    expect(() =>
      SetAnnouncementActiveSchema.parse({ isActive: false, reason: "" })
    ).toThrow()
    const { announcements } = await listActiveAnnouncements(false)
    expect(announcements.map((a) => a.id)).not.toContain(created.id)
  })

  it("has no delete endpoint", () => {
    expect(
      (platformOps as Record<string, unknown>).deleteAnnouncement
    ).toBeUndefined()
  })

  it("forbids announcements for MANAGER and SUPPORT", async () => {
    await expect(
      createAnnouncement(managerSession, {
        title: "T",
        body: "B",
        audience: "ALL",
      })
    ).rejects.toThrowError(ApiError)
    await expect(listAnnouncements(supportSession)).rejects.toThrowError(
      ApiError
    )
  })
})

// ─── Audit trail ──────────────────────────────────────────────────────

describe("audit trail", () => {
  it("filters by actor, target user, action, outcome and correlationId", async () => {
    const byActor = await listAuditLogs(ownerSession, {
      actorId: "manager-1",
      page: 1,
      perPage: 20,
    })
    expect(byActor.logs.map((l) => l.id)).toEqual(["audit-2"])
    const byTarget = await listAuditLogs(ownerSession, {
      targetUserId: "user-1",
      page: 1,
      perPage: 20,
    })
    expect(byTarget.logs.map((l) => l.id)).toEqual(["audit-1"])
    const byAction = await listAuditLogs(ownerSession, {
      action: "DELETE",
      page: 1,
      perPage: 20,
    })
    expect(byAction.logs.map((l) => l.id)).toEqual(["audit-3"])
    const byOutcome = await listAuditLogs(ownerSession, {
      outcome: "FAILED",
      page: 1,
      perPage: 20,
    })
    expect(byOutcome.logs.map((l) => l.id)).toEqual(["audit-3"])
    const byCorr = await listAuditLogs(ownerSession, {
      correlationId: "corr-1",
      page: 1,
      perPage: 20,
    })
    expect(byCorr.logs.map((l) => l.id)).toEqual(["audit-1"])
    await expect(
      listAuditLogs(ownerSession, {
        action: "NOPE",
        page: 1,
        perPage: 20,
      })
    ).rejects.toThrowError(ApiError)
  })

  it("reads one entry and 404s on an unknown id", async () => {
    const row = await getAuditLog(ownerSession, "audit-2")
    expect(row.actor?.email).toBe("manager@example.com")
    await expect(getAuditLog(ownerSession, "missing")).rejects.toThrowError(
      ApiError
    )
  })

  it("exports only for EXPORT_AUDIT_LOGS holders", async () => {
    const exported = await exportAuditLogs(ownerSession, {
      page: 1,
      perPage: 20,
    })
    expect(exported.total).toBe(4)
    await expect(
      exportAuditLogs(managerSession, { page: 1, perPage: 20 })
    ).rejects.toThrowError(ApiError)
  })

  it("exports no AuditLog mutation (immutability proof)", () => {
    const names = Object.keys(platformOps)
    expect(
      names.filter((n) => /audit/i.test(n) && /update|delete/i.test(n))
    ).toEqual([])
    expect(
      (platformOps as Record<string, unknown>).updateAuditLog
    ).toBeUndefined()
    expect(
      (platformOps as Record<string, unknown>).deleteAuditLog
    ).toBeUndefined()
  })

  it("idempotency: the same correlationId writes one row", async () => {
    const input = {
      userId: "admin-1",
      action: "UPDATE" as const,
      resourceType: "USER" as const,
      resourceId: "user-2",
      detail: { event: "test-idempotent" },
      correlationId: "corr-dedupe-1",
    }
    await logAudit(input)
    await logAudit(input)
    const rows = store.auditLogs.filter(
      (l) => l.correlationId === "corr-dedupe-1"
    )
    expect(rows).toHaveLength(1)
  })

  it("records a refused sensitive action with outcome FAILED", async () => {
    // An APPROVED request for the platform owner: the erasure is
    // refused (403) and the refusal itself is audited FAILED.
    store.deletionRequests.set("dr-owner", {
      id: "dr-owner",
      userId: "admin-1",
      status: "APPROVED",
      reason: "Test",
      reviewedById: "admin-1",
      reviewedAt: new Date(),
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const before = store.auditLogs.filter((l) => l.outcome === "FAILED").length
    await expect(
      executeErasure(ownerSession, "dr-owner", { reason: "No" })
    ).rejects.toThrowError(ApiError)
    const failed = store.auditLogs.filter((l) => l.outcome === "FAILED")
    expect(failed.length).toBe(before + 1)
    expect(failed.at(-1)).toMatchObject({
      resourceType: "DELETION_REQUEST",
      resourceId: "dr-owner",
    })
    expect((failed.at(-1)?.detail as Record<string, unknown>)?.event).toBe(
      "erasure-refused-owner"
    )
  })
})

// ─── Health + system ──────────────────────────────────────────────────

describe("health and system", () => {
  it("returns real counts, outbox depth, AI calls and MCP error rate", async () => {
    const health = await getPlatformHealth(ownerSession)
    expect(health.database.status).toBe("connected")
    expect(health.database.latencyMs).toBeGreaterThanOrEqual(0)
    expect(health.counts).toEqual({
      users: 7,
      forms: 2,
      domains: 2,
      submissionsToday: 3,
    })
    expect(health.outbox.pending).toBe(2)
    expect(health.outbox.oldestPendingAgeMinutes).toBeGreaterThanOrEqual(170)
    expect(health.ai.callsToday).toBe(40)
    expect(health.ai.providersEnabled).toBe(3)
    expect(health.mcp.callsLast24h).toBe(3)
    expect(health.mcp.errorRate24h).toBeCloseTo(1 / 3)
    expect(health.mcp.globalEnabled).toBe(true)
    expect(health.emergency).toBe(false)
  })

  it("returns runtime versions and env presence only", async () => {
    const summary = await getSystemSummary(ownerSession)
    expect(summary.nodeVersion).toBe(process.version)
    expect(summary.postgresVersion).toContain("PostgreSQL 16.1")
    expect(typeof summary.prismaClientVersion).toBe("string")
    expect(summary.prismaClientVersion.length).toBeGreaterThan(0)
    for (const value of Object.values(summary.env)) {
      expect(typeof value).toBe("boolean")
    }
    expect(summary.emergency).toBe(false)
  })
})

// ─── Abuse / spam queue ───────────────────────────────────────────────

describe("abuse queue", () => {
  it("lists metadata only, filters by status and search", async () => {
    const all = await listPlatformSubmissions(ownerSession, {
      page: 1,
      perPage: 20,
    })
    expect(all.total).toBe(6)
    for (const row of all.submissions) {
      expect(row).not.toHaveProperty("data")
    }
    const spam = await listPlatformSubmissions(ownerSession, {
      status: "SPAM",
      page: 1,
      perPage: 20,
    })
    expect(spam.submissions.map((s) => s.id).sort()).toEqual(["sub-2", "sub-3"])
    const byDomain = await listPlatformSubmissions(ownerSession, {
      search: "sendcms.bond",
      page: 1,
      perPage: 20,
    })
    expect(byDomain.total).toBe(6)
    const byForm = await listPlatformSubmissions(ownerSession, {
      search: "Support",
      page: 1,
      perPage: 20,
    })
    expect(byForm.submissions.map((s) => s.id).sort()).toEqual([
      "sub-4",
      "sub-5",
    ])
  })

  it("reads the full submission only with VIEW_SENSITIVE_SUBMISSIONS and audits it", async () => {
    const detail = await getPlatformSubmission(ownerSession, "sub-2")
    expect(detail.data).toBeDefined()
    expect(detail.form.owner?.email).toBe("customer1@example.com")
    const audit = store.auditLogs.find(
      (l) =>
        l.resourceId === "sub-2" &&
        (l.detail as Record<string, unknown>)?.event ===
          "sensitive-submission-access"
    )
    expect(audit).toBeDefined()
    await expect(
      getPlatformSubmission(plainSession, "sub-2")
    ).rejects.toThrowError(ApiError)
  })

  it("reports spam stats with 30-day top submitters", async () => {
    const stats = await getSpamStats(ownerSession)
    expect(stats.byStatus).toEqual(
      expect.arrayContaining([
        { status: "SPAM", count: 2 },
        { status: "NEW", count: 2 },
      ])
    )
    expect(stats.topSpamForms[0]).toMatchObject({
      formId: "form-1",
      spamCount: 2,
    })
    // user-1 has 3 submissions in the last 30 days (sub-6 is 40 days
    // old); user-2 has 2.
    expect(stats.topSubmitters[0]).toMatchObject({
      userId: "user-1",
      submissionsLast30Days: 3,
    })
    expect(stats.topSubmitters[1]).toMatchObject({
      userId: "user-2",
      submissionsLast30Days: 2,
    })
  })

  it("maps target statuses onto the inbox transition rules", async () => {
    // SPAM -> NEW restores to READ (the inbox rule, not NEW).
    const restored = await updatePlatformSubmissionStatus(
      ownerSession,
      "sub-2",
      { status: "NEW", reason: "False positive" }
    )
    expect(restored).toMatchObject({ status: "READ", changed: true })
    // READ -> SPAM works.
    const spammed = await updatePlatformSubmissionStatus(
      ownerSession,
      "sub-4",
      { status: "SPAM", reason: "Spam" }
    )
    expect(spammed).toMatchObject({ status: "SPAM", changed: true })
    // ARCHIVED -> SPAM is an illegal transition: a no-op, not an error.
    const noop = await updatePlatformSubmissionStatus(ownerSession, "sub-5", {
      status: "SPAM",
      reason: "Spam",
    })
    expect(noop).toMatchObject({ status: "ARCHIVED", changed: false })
    expect(() =>
      UpdatePlatformSubmissionStatusSchema.parse({ status: "SPAM" })
    ).toThrow()
  })

  it("forbids status changes for SUPPORT", async () => {
    await expect(
      updatePlatformSubmissionStatus(supportSession, "sub-2", {
        status: "SPAM",
        reason: "No",
      })
    ).rejects.toThrowError(ApiError)
  })
})

// ─── Deletion workflow ────────────────────────────────────────────────

describe("deletion workflow", () => {
  it("state machine: REQUESTED -> APPROVED -> COMPLETED, reject path", async () => {
    const approved = await reviewDeletionRequest(ownerSession, "dr-1", {
      decision: "APPROVED",
      reason: "Verified",
    })
    expect(approved.status).toBe("APPROVED")
    await expect(
      reviewDeletionRequest(ownerSession, "dr-1", {
        decision: "REJECTED",
        reason: "Too late",
      })
    ).rejects.toThrowError(ApiError)
    expect(() =>
      ReviewDeletionRequestSchema.parse({ decision: "APPROVED" })
    ).toThrow()
  })

  it("rejects a REQUESTED request", async () => {
    const rejected = await reviewDeletionRequest(ownerSession, "dr-1", {
      decision: "REJECTED",
      reason: "Duplicate",
    })
    expect(rejected.status).toBe("REJECTED")
  })

  it("erases an APPROVED request: anonymize + delete, keep history", async () => {
    const beforeAudit = store.auditLogs.length
    const beforeSubs = store.subscriptions.length
    const beforeLedger = store.usageLedger.length
    const beforeAiUsage = store.aiUsageRecords.length
    const beforeMcpUsage = store.mcpUsageRecords.length
    const completed = await executeErasure(ownerSession, "dr-2", {
      reason: "GDPR erasure",
    })
    expect(completed.status).toBe("COMPLETED")
    expect(completed.completedAt).toBeInstanceOf(Date)
    const user = store.users.get("user-2")!
    expect(user.email).toMatch(/^deleted-[a-z0-9-]+\@deleted\.local$/)
    expect(user.email).toBe("deleted-user-2@deleted.local")
    expect(user.name).toBe("Deleted user")
    expect(user.image).toBeNull()
    expect(user.status).toBe("DISABLED")
    expect(user.locale).toBeNull()
    expect(user.deletionCompletedAt).toBeInstanceOf(Date)
    expect(store.apiKeys.filter((k) => k.userId === "user-2")).toHaveLength(1)
    expect(
      store.apiKeys.find((k) => k.id === "key-3")?.revokedAt
    ).toBeInstanceOf(Date)
    expect(store.sessions.filter((s) => s.userId === "user-2")).toHaveLength(0)
    expect(store.accounts.filter((a) => a.userId === "user-2")).toHaveLength(0)
    expect(store.userAiKeys.filter((k) => k.userId === "user-2")).toHaveLength(
      0
    )
    expect(store.forms.has("form-2")).toBe(false)
    expect(store.domains.has("domain-2")).toBe(false)
    // Billing/audit history survives erasure.
    expect(store.auditLogs.length).toBeGreaterThan(beforeAudit)
    expect(store.subscriptions.length).toBe(beforeSubs)
    expect(store.usageLedger.length).toBe(beforeLedger)
    expect(store.aiUsageRecords.length).toBe(beforeAiUsage)
    expect(store.mcpUsageRecords.length).toBe(beforeMcpUsage)
    const audit = store.auditLogs.find(
      (l) =>
        l.resourceId === "dr-2" &&
        (l.detail as Record<string, unknown>)?.event === "account-erased"
    )
    expect(audit).toBeDefined()
    expect((audit?.detail as Record<string, unknown>)?.counts).toMatchObject({
      formsDeleted: 1,
      domainsDeleted: 1,
    })
    expect(JSON.stringify(audit?.detail)).not.toMatch(/customer2@example\.com/)
  })

  it("refuses the owner, self-erasure, and a non-APPROVED request", async () => {
    // Owner: build a request for the owner first.
    store.deletionRequests.set("dr-owner", {
      id: "dr-owner",
      userId: "admin-1",
      status: "APPROVED",
      reason: "Test",
      reviewedById: "admin-1",
      reviewedAt: new Date(),
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    const beforeFailed = store.auditLogs.filter(
      (l) => l.outcome === "FAILED"
    ).length
    await expect(
      executeErasure(ownerSession, "dr-owner", { reason: "No" })
    ).rejects.toThrowError(ApiError)
    await expect(
      executeErasure(
        makeSession({
          id: "user-2",
          email: "customer2@example.com",
          platformRole: "PLATFORM_USER",
          adminRole: "SUPER_ADMIN",
        }),
        "dr-2",
        { reason: "Self" }
      )
    ).rejects.toThrowError(ApiError)
    await expect(
      executeErasure(ownerSession, "dr-1", { reason: "Too early" })
    ).rejects.toThrowError(ApiError)
    expect(store.auditLogs.filter((l) => l.outcome === "FAILED").length).toBe(
      beforeFailed + 3
    )
    expect(() => ExecuteErasureSchema.parse({ reason: "" })).toThrow()
  })

  it("requestDeletion creates the workflow row (Phase 3 wiring)", async () => {
    // A fresh user with no open request (user-1 already has dr-1
    // REQUESTED in the seed, so a second request for them is a 409).
    seedUser("user-4", { name: "New", email: "new@example.com" })
    const created = await requestDeletion(ownerSession, "user-4", {
      reason: "Leaving",
    })
    expect(created.deletionRequestId).toBeDefined()
    expect(created.deletionRequestReason).toBe("Leaving")
    const row = store.deletionRequests.get(created.deletionRequestId)
    expect(row?.status).toBe("REQUESTED")
    expect(row?.reason).toBe("Leaving")
    await expect(
      requestDeletion(ownerSession, "user-4", { reason: "Again" })
    ).rejects.toThrowError(ApiError)
  })
})

// ─── Translation completion ───────────────────────────────────────────

describe("translation completion", () => {
  const fakeShared: Record<string, Record<string, Record<string, string>>> = {
    en: { common: { a: "A", b: "B", c: "C" }, actions: { save: "Save" } },
    ur: { common: { a: "A", b: "B" }, actions: { save: "Save" } },
  }
  const fakeApp: Record<string, Record<string, Record<string, string>>> = {
    en: { "admin/mcp": { x: "X", y: "Y" } },
    ur: { "admin/mcp": {} },
  }

  beforeEach(() => {
    mockLoadDomain.mockImplementation(
      async (locale: string, domain: string) =>
        fakeShared[locale]?.[domain] ?? {}
    )
    mockLoadAppDomain.mockImplementation(
      async (locale: string, app: string, domain: string) =>
        fakeApp[locale]?.[`${app}/${domain}`] ?? {}
    )
  })

  it("detects missing keys per locale and domain", async () => {
    const { locales } = await getTranslationCompletion(ownerSession)
    const en = locales.find((l) => l.code === "en")!
    const ur = locales.find((l) => l.code === "ur")!
    expect(en.overallPercent).toBe(100)
    // en has 3 (common) + 1 (actions) + 2 (admin/mcp) = 6 keys; ur
    // has 2 + 1 + 0 = 3 translated.
    expect(ur.overallPercent).toBe(50)
    const common = ur.domains.find((d) => d.domain === "common")!
    expect(common).toMatchObject({ total: 3, translated: 2 })
    expect(common.missingKeys).toEqual(["c"])
    const mcp = ur.domains.find((d) => d.domain === "mcp")!
    expect(mcp).toMatchObject({ total: 2, translated: 0 })
    expect(mcp.missingKeys).toEqual(["x", "y"])
    const es = locales.find((l) => l.code === "es")!
    expect(es.overallPercent).toBe(0)
  })

  it("exports one locale as a bundle and rejects an unknown locale", async () => {
    const bundle = await exportTranslations(ownerSession, "ur")
    expect(bundle.locale).toBe("ur")
    expect(bundle.domains["common"]).toEqual({ a: "A", b: "B" })
    expect(bundle.domains["admin/mcp"]).toEqual({})
    await expect(exportTranslations(ownerSession, "xx")).rejects.toThrowError(
      ApiError
    )
    await expect(getTranslationCompletion(managerSession)).rejects.toThrowError(
      ApiError
    )
  })
})
