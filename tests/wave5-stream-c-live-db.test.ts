// Wave 5 Stream C — LIVE-DB regression tests for the race findings
// (DB-026, DB-027, SRC-220) plus live checks for PRF-013, PRF-014,
// ADM-092, ADM-093, SRC-238, ADM-010.
//
// These run against a REAL Postgres — the mocked suites cannot prove
// a race is closed, only that the code takes the conditional path.
// They are SKIPPED unless WAVE5_LIVE_DB=1 and DATABASE_URL points at
// a scratch database: they create and then delete their own users,
// tickets, announcements, flags, submissions and audit rows, and
// assert the table counts return to baseline afterwards.
//
// Run: WAVE5_LIVE_DB=1 DATABASE_URL='postgresql://...' pnpm vitest
//   run tests/wave5-stream-c-live-db.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { db } from "@sendcms/database"
import type { AdminSession } from "@sendcms/auth"
import {
  addAdminNote,
  disableUser,
  requestDeletion,
  suspendUser,
} from "@sendcms/admin-users"
import {
  createAnnouncement,
  createFlag,
  deleteFlag,
  exportAuditLogs,
  getAdminOverview,
  getFlag,
  listAnnouncements,
  reviewDeletionRequest,
  setAnnouncementActive,
  setFlagOverride,
} from "@sendcms/platform-ops"
import {
  TICKET_TRANSITIONS,
  createTicket,
  replyToTicket,
  setTicketStatus,
} from "@sendcms/support"
import { ApiError } from "@sendcms/api-client"

const enabled = process.env.WAVE5_LIVE_DB === "1"
const run = `w5${Date.now().toString(36)}${Math.random()
  .toString(36)
  .slice(2, 6)}`

const auditEvent = (row: { detail: unknown }): string | undefined =>
  (row.detail as { event?: string } | null)?.event

function makeSession(user: {
  id: string
  name: string | null
  email: string
  platformRole: "PLATFORM_OWNER" | "PLATFORM_USER"
  adminRole: null
}): AdminSession {
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      image: null,
      platformRole: user.platformRole,
      status: "ACTIVE",
      adminRole: null,
      emailVerified: true,
    },
    session: {
      id: `sess-${run}`,
      userId: user.id,
      expiresAt: new Date(Date.now() + 3600_000),
    },
  }
}

describe.skipIf(!enabled)(
  "Wave 5 Stream C — live DB (Postgres, scratch database)",
  () => {
    let owner: { id: string; email: string }
    let ownerSession: AdminSession
    let customer: { id: string; email: string }
    let formId: string
    let domainId: string
    const userIds: string[] = []
    const ticketIds: string[] = []
    const announcementIds: string[] = []
    const deletionRequestIds: string[] = []
    const resourceIds: string[] = []
    let baseline: Record<string, number> = {}

    async function seedStepUp(userId: string): Promise<void> {
      await db.stepUpVerification.create({
        data: {
          userId,
          action: null,
          verifiedAt: new Date(),
          expiresAt: new Date(Date.now() + 10 * 60_000),
        },
      })
    }

    async function makeTicket() {
      const ticket = await createTicket(customer.id, {
        subject: `Wave5 race ${run}`,
        body: "Race test ticket.",
        priority: "NORMAL",
      })
      ticketIds.push(ticket.id)
      resourceIds.push(ticket.id)
      return ticket
    }

    async function auditEventsFor(resourceId: string): Promise<string[]> {
      const rows = await db.auditLog.findMany({
        where: { resourceId },
        select: { detail: true },
      })
      return rows
        .map((r) => auditEvent(r))
        .filter((e): e is string => typeof e === "string")
    }

    beforeAll(async () => {
      baseline = {
        auditLog: await db.auditLog.count(),
        submission: await db.submission.count(),
        announcement: await db.announcement.count(),
        user: await db.user.count(),
        supportTicket: await db.supportTicket.count(),
        deletionRequest: await db.deletionRequest.count(),
        featureFlag: await db.featureFlag.count(),
      }
      owner = await db.user.create({
        data: {
          name: "Wave5 Owner",
          email: `wave5-owner-${run}@example.com`,
          emailVerified: true,
          platformRole: "PLATFORM_OWNER",
        },
        select: { id: true, email: true },
      })
      userIds.push(owner.id)
      ownerSession = makeSession({
        ...owner,
        name: "Wave5 Owner",
        platformRole: "PLATFORM_OWNER",
        adminRole: null,
      })
      customer = await db.user.create({
        data: {
          name: "Wave5 Customer",
          email: `wave5-customer-${run}@example.com`,
          emailVerified: true,
          platformRole: "PLATFORM_USER",
        },
        select: { id: true, email: true },
      })
      userIds.push(customer.id)
      resourceIds.push(customer.id)
      const domain = await db.domain.create({
        data: {
          name: `Wave5 ${run}`,
          domain: `wave5-${run}.example.com`,
          status: "VERIFIED",
          ownerId: customer.id,
        },
      })
      domainId = domain.id
      const form = await db.form.create({
        data: { name: `Wave5 ${run}`, ownerId: customer.id },
      })
      formId = form.id
    }, 60_000)

    afterAll(async () => {
      // Delete everything this file created, then prove the counts
      // returned to baseline.
      const allResourceIds = [...new Set(resourceIds)]
      await db.auditLog.deleteMany({
        where: {
          OR: [
            { userId: { in: userIds } },
            { resourceId: { in: allResourceIds } },
            { resourceId: { startsWith: "wave5-prf014" } },
          ],
        },
      })
      await db.ticketMessage.deleteMany({
        where: { ticketId: { in: ticketIds } },
      })
      await db.supportTicket.deleteMany({
        where: { id: { in: ticketIds } },
      })
      await db.deletionRequest.deleteMany({
        where: { id: { in: deletionRequestIds } },
      })
      await db.announcement.deleteMany({
        where: { id: { in: announcementIds } },
      })
      await db.submission.deleteMany({ where: { formId } })
      await db.form.deleteMany({ where: { id: formId } })
      await db.domain.deleteMany({ where: { id: domainId } })
      await db.stepUpVerification.deleteMany({
        where: { userId: owner.id },
      })
      await db.user.deleteMany({ where: { id: { in: userIds } } })
      const after = {
        auditLog: await db.auditLog.count(),
        submission: await db.submission.count(),
        announcement: await db.announcement.count(),
        user: await db.user.count(),
        supportTicket: await db.supportTicket.count(),
        deletionRequest: await db.deletionRequest.count(),
        featureFlag: await db.featureFlag.count(),
      }
      for (const [table, count] of Object.entries(after)) {
        if (count !== baseline[table]) {
          throw new Error(
            `Wave5 live-DB cleanup left ${table} at ${count}, baseline was ${baseline[table]}`
          )
        }
      }
    }, 60_000)

    it("DB-026: a reply racing a close is refused (409) with no message row", async () => {
      // Deterministic half: the ticket is already CLOSED.
      const closed = await makeTicket()
      await setTicketStatus(ownerSession, closed.id, {
        status: "CLOSED",
        reason: "Race setup",
      })
      await expect(
        replyToTicket(customer.id, closed.id, { body: "Too late." })
      ).rejects.toMatchObject({ status: 409 })
      const closedCount = await db.ticketMessage.count({
        where: { ticketId: closed.id },
      })
      expect(closedCount).toBe(1)

      // Concurrent half: 20 fresh tickets, reply vs close fired
      // together. Either order is legal — but a reply that loses
      // the race must 409 with no message row, and a reply that
      // wins must leave exactly one extra message.
      for (let i = 0; i < 20; i++) {
        const ticket = await makeTicket()
        const [reply, close] = await Promise.allSettled([
          replyToTicket(customer.id, ticket.id, {
            body: `Race reply ${i}.`,
          }),
          setTicketStatus(ownerSession, ticket.id, {
            status: "CLOSED",
            reason: "Race close",
          }),
        ])
        expect(close.status).toBe("fulfilled")
        const messageCount = await db.ticketMessage.count({
          where: { ticketId: ticket.id },
        })
        if (reply.status === "rejected") {
          expect((reply.reason as ApiError).status).toBe(409)
          expect(messageCount).toBe(1)
        } else {
          expect(messageCount).toBe(2)
        }
        const final = await db.supportTicket.findUnique({
          where: { id: ticket.id },
          select: { status: true },
        })
        expect(final?.status).toBe("CLOSED")
      }
    }, 60_000)

    it("DB-026: concurrent setTicketStatus from one start status — exactly one wins per pair", async () => {
      // Same target twice: the second call reads the first one's
      // committed result, where the same transition is illegal.
      const ticket = await makeTicket()
      const [first, second] = await Promise.allSettled([
        setTicketStatus(ownerSession, ticket.id, {
          status: "RESOLVED",
          reason: "Race A",
        }),
        setTicketStatus(ownerSession, ticket.id, {
          status: "RESOLVED",
          reason: "Race B",
        }),
      ])
      const fulfilled = [first, second].filter((r) => r.status === "fulfilled")
      const rejected = [first, second].filter((r) => r.status === "rejected")
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        status: 409,
      })
      const events = (await auditEventsFor(ticket.id)).filter(
        (e) => e === "ticket-status-changed"
      )
      expect(events).toHaveLength(1)

      // Distinct targets: no pair in the machine is mutually
      // exclusive in both orders (RESOLVED→CLOSED is legal), so
      // the deterministic property is sequential consistency —
      // every applied transition was legal from the status it
      // actually replaced, and the audit trail shows exactly the
      // transitions that applied.
      const ticket2 = await makeTicket()
      const outcomes = await Promise.allSettled([
        setTicketStatus(ownerSession, ticket2.id, {
          status: "RESOLVED",
          reason: "Race C",
        }),
        setTicketStatus(ownerSession, ticket2.id, {
          status: "IN_PROGRESS",
          reason: "Race D",
        }),
      ])
      expect(
        outcomes.filter((r) => r.status === "fulfilled").length
      ).toBeGreaterThanOrEqual(1)
      const rows = await db.auditLog.findMany({
        where: { resourceId: ticket2.id },
        select: { detail: true },
      })
      const changes = rows
        .map(
          (r) =>
            r.detail as {
              event?: string
              oldStatus?: string
              newStatus?: string
            } | null
        )
        .filter(
          (d): d is { event: string; oldStatus: string; newStatus: string } =>
            !!d && d.event === "ticket-status-changed"
        )
      expect(changes.length).toBe(
        outcomes.filter((r) => r.status === "fulfilled").length
      )
      for (const change of changes) {
        expect(
          TICKET_TRANSITIONS[
            change.oldStatus as keyof typeof TICKET_TRANSITIONS
          ]
        ).toContain(change.newStatus)
      }
    }, 60_000)

    it("DB-027: concurrent suspend + disable — exactly one succeeds, one audit event", async () => {
      for (let i = 0; i < 5; i++) {
        const target = await db.user.create({
          data: {
            name: `Wave5 Target ${i}`,
            email: `wave5-target-${run}-${i}@example.com`,
            emailVerified: true,
            platformRole: "PLATFORM_USER",
          },
          select: { id: true },
        })
        userIds.push(target.id)
        resourceIds.push(target.id)
        await seedStepUp(owner.id)
        const [suspend, disable] = await Promise.allSettled([
          suspendUser(ownerSession, target.id, { reason: "Race suspend" }),
          disableUser(ownerSession, target.id, { reason: "Race disable" }),
        ])
        const fulfilled = [suspend, disable].filter(
          (r) => r.status === "fulfilled"
        )
        const rejected = [suspend, disable].filter(
          (r) => r.status === "rejected"
        )
        expect(fulfilled).toHaveLength(1)
        expect(rejected).toHaveLength(1)
        expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
          status: 409,
        })
        const final = await db.user.findUnique({
          where: { id: target.id },
          select: { status: true },
        })
        expect(["SUSPENDED", "DISABLED"]).toContain(final?.status)
        const events = (await auditEventsFor(target.id)).filter((e) =>
          ["user-suspended", "user-disabled"].includes(e)
        )
        expect(events).toHaveLength(1)
      }
    }, 60_000)

    it("SRC-220: two concurrent opposite reviews — exactly one succeeds", async () => {
      for (let i = 0; i < 3; i++) {
        const target = await db.user.create({
          data: {
            name: `Wave5 Erase ${i}`,
            email: `wave5-erase-${run}-${i}@example.com`,
            emailVerified: true,
            platformRole: "PLATFORM_USER",
          },
          select: { id: true },
        })
        userIds.push(target.id)
        const { deletionRequestId } = await requestDeletion(
          ownerSession,
          target.id,
          { reason: "Wave5 race" }
        )
        deletionRequestIds.push(deletionRequestId)
        resourceIds.push(deletionRequestId)
        await seedStepUp(owner.id)
        const [approve, reject] = await Promise.allSettled([
          reviewDeletionRequest(ownerSession, deletionRequestId, {
            decision: "APPROVED",
            reason: "Race approve",
          }),
          reviewDeletionRequest(ownerSession, deletionRequestId, {
            decision: "REJECTED",
            reason: "Race reject",
          }),
        ])
        const fulfilled = [approve, reject].filter(
          (r) => r.status === "fulfilled"
        )
        const rejected = [approve, reject].filter(
          (r) => r.status === "rejected"
        )
        expect(fulfilled).toHaveLength(1)
        expect(rejected).toHaveLength(1)
        expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
          status: 409,
        })
        const final = await db.deletionRequest.findUnique({
          where: { id: deletionRequestId },
          select: { status: true },
        })
        expect(["APPROVED", "REJECTED"]).toContain(final?.status)
        const events = (await auditEventsFor(deletionRequestId)).filter(
          (e) => e === "deletion-request-reviewed"
        )
        expect(events).toHaveLength(1)
      }
    }, 60_000)

    it("PRF-013: 12mo overview returns ≤366 per-day rows with correct counts", async () => {
      const now = Date.now()
      const rows = Array.from({ length: 300 }, (_, i) => ({
        formId,
        ownerId: owner.id,
        data: {},
        originDomain: `wave5-${run}.example.com`,
        status: "NEW" as const,
        createdAt: new Date(now - i * 1.3 * 24 * 60 * 60 * 1000),
      }))
      await db.submission.createMany({ data: rows })
      const overview = await getAdminOverview(ownerSession, {
        range: "12mo",
      })
      expect(overview.submissions.perDay.length).toBeLessThanOrEqual(366)
      const daySum = overview.submissions.perDay.reduce(
        (sum, d) => sum + d.count,
        0
      )
      expect(daySum).toBe(overview.submissions.inRange)
      const expected = await db.submission.count({
        where: {
          createdAt: {
            gte: new Date(overview.range.from),
            lte: new Date(overview.range.to),
          },
        },
      })
      expect(overview.submissions.inRange).toBe(expected)
    })

    it("PRF-014: the export cap holds on real rows", async () => {
      await db.auditLog.createMany({
        data: Array.from({ length: 150 }, (_, i) => ({
          action: "UPDATE" as const,
          resourceType: "USER" as const,
          resourceId: `wave5-prf014-${run}-${i}`,
          detail: {},
          userId: owner.id,
        })),
      })
      const capped = await exportAuditLogs(
        ownerSession,
        { page: 1, perPage: 20 },
        100
      )
      expect(capped.logs).toHaveLength(100)
      expect(capped.total).toBeGreaterThanOrEqual(150)
      expect(capped.capped).toBe(true)
      expect(capped.limit).toBe(100)
      const full = await exportAuditLogs(ownerSession, {
        page: 1,
        perPage: 20,
      })
      expect(full.limit).toBe(10000)
      expect(full.logs.length).toBeLessThanOrEqual(10000)
    })

    it("ADM-092: create → DELETE → 404, overrides removed, audit written; system flag 422", async () => {
      const key = `wave5-flag-${run}`
      await createFlag(ownerSession, { key, name: "Wave5 flag" })
      await setFlagOverride(ownerSession, key, customer.id, {
        isEnabled: true,
        reason: "Wave5 test",
      })
      const removed = await deleteFlag(ownerSession, key, {
        reason: "Wave5 cleanup",
      })
      expect(removed).toEqual({
        deleted: true,
        key,
        overridesRemoved: 1,
      })
      await expect(getFlag(ownerSession, key)).rejects.toMatchObject({
        status: 404,
      })
      const events = await auditEventsFor(key)
      expect(events).toContain("flag-deleted")
      await expect(
        deleteFlag(ownerSession, "ai-spam-rescore", { reason: "x" })
      ).rejects.toMatchObject({ status: 422 })
    })

    it("ADM-093: 25 announcements — page 2 holds rows 21-25, filters match exactly", async () => {
      for (let i = 1; i <= 25; i++) {
        const ann = await createAnnouncement(ownerSession, {
          title: `Wave5 ann ${i}`,
          body: "Seeded",
          audience: i % 2 === 0 ? "ADMIN_ONLY" : "ALL",
        })
        announcementIds.push(ann.id)
        if (i % 3 === 0) {
          await setAnnouncementActive(ownerSession, ann.id, {
            isActive: false,
            reason: "Wave5 seed",
          })
        }
      }
      const page2 = await listAnnouncements(ownerSession, {
        page: 2,
        perPage: 20,
      })
      expect(page2.total).toBe(25)
      expect(page2.announcements).toHaveLength(5)
      const inactive = await listAnnouncements(ownerSession, {
        isActive: false,
      })
      expect(inactive.total).toBe(8)
      expect(inactive.announcements.every((a) => !a.isActive)).toBe(true)
      const adminOnly = await listAnnouncements(ownerSession, {
        audience: "ADMIN_ONLY",
      })
      expect(adminOnly.total).toBe(12)
      expect(
        adminOnly.announcements.every((a) => a.audience === "ADMIN_ONLY")
      ).toBe(true)
    })

    it("SRC-238: createTicket for a nonexistent user is a 404", async () => {
      await expect(
        createTicket(`wave5-ghost-${run}`, {
          subject: "Ghost",
          body: "Nobody here.",
          priority: "NORMAL",
        })
      ).rejects.toMatchObject({ status: 404 })
    })

    it("ADM-010: a note writes an audit row for the user", async () => {
      await addAdminNote(ownerSession, customer.id, {
        body: "Wave5 live note.",
      })
      const events = await auditEventsFor(customer.id)
      expect(events).toContain("admin-note-added")
    })
  }
)
