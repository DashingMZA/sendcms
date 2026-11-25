import { describe, expect, it } from "vitest"
import { resolveStatusAction } from "@sendcms/inbox"
import {
  BulkUpdateSubmissionsSchema,
  DraftReplySchema,
  InboxListQuerySchema,
  SendReplySchema,
  UpdateSubmissionStatusSchema,
  isValidCalendarDate,
} from "@sendcms/inbox/validators"
import { getSubmissionSender, previewSubmissionText } from "@sendcms/shared"

import { SubmissionEventType, SubmissionStatus } from "@sendcms/database"

describe("resolveStatusAction", () => {
  it("read: NEW -> READ with a READ event", () => {
    expect(resolveStatusAction("read", SubmissionStatus.NEW)).toEqual({
      status: SubmissionStatus.READ,
      event: SubmissionEventType.READ,
    })
  })

  it("read is a no-op for READ, STARRED, ARCHIVED and SPAM", () => {
    for (const status of [
      SubmissionStatus.READ,
      SubmissionStatus.STARRED,
      SubmissionStatus.ARCHIVED,
      SubmissionStatus.SPAM,
    ]) {
      expect(resolveStatusAction("read", status)).toBeNull()
    }
  })

  it("unread: READ and STARRED -> NEW with an UNREAD event", () => {
    for (const status of [SubmissionStatus.READ, SubmissionStatus.STARRED]) {
      expect(resolveStatusAction("unread", status)).toEqual({
        status: SubmissionStatus.NEW,
        event: SubmissionEventType.UNREAD,
      })
    }
    expect(resolveStatusAction("unread", SubmissionStatus.NEW)).toBeNull()
    expect(resolveStatusAction("unread", SubmissionStatus.ARCHIVED)).toBeNull()
  })

  it("star / unstar round-trips through READ", () => {
    expect(resolveStatusAction("star", SubmissionStatus.NEW)).toEqual({
      status: SubmissionStatus.STARRED,
      event: SubmissionEventType.STARRED,
    })
    expect(resolveStatusAction("star", SubmissionStatus.READ)).toEqual({
      status: SubmissionStatus.STARRED,
      event: SubmissionEventType.STARRED,
    })
    expect(resolveStatusAction("star", SubmissionStatus.STARRED)).toBeNull()
    expect(resolveStatusAction("unstar", SubmissionStatus.STARRED)).toEqual({
      status: SubmissionStatus.READ,
      event: SubmissionEventType.UNSTARRED,
    })
    expect(resolveStatusAction("unstar", SubmissionStatus.READ)).toBeNull()
  })

  it("archive / restore: archived and spam must be restored first", () => {
    expect(resolveStatusAction("archive", SubmissionStatus.READ)).toEqual({
      status: SubmissionStatus.ARCHIVED,
      event: SubmissionEventType.ARCHIVED,
    })
    expect(resolveStatusAction("archive", SubmissionStatus.SPAM)).toBeNull()
    expect(resolveStatusAction("restore", SubmissionStatus.ARCHIVED)).toEqual({
      status: SubmissionStatus.READ,
      event: SubmissionEventType.RESTORED,
    })
    expect(resolveStatusAction("restore", SubmissionStatus.NEW)).toBeNull()
  })

  it("spam / not-spam", () => {
    expect(resolveStatusAction("spam", SubmissionStatus.NEW)).toEqual({
      status: SubmissionStatus.SPAM,
      event: SubmissionEventType.MARKED_SPAM,
    })
    expect(resolveStatusAction("spam", SubmissionStatus.SPAM)).toBeNull()
    expect(resolveStatusAction("not-spam", SubmissionStatus.SPAM)).toEqual({
      status: SubmissionStatus.READ,
      event: SubmissionEventType.RESTORED,
    })
    expect(resolveStatusAction("not-spam", SubmissionStatus.READ)).toBeNull()
  })
})

describe("getSubmissionSender", () => {
  it("extracts name and email, case-insensitively", () => {
    expect(
      getSubmissionSender({
        Name: "Ali",
        EMAIL: "ali@example.com",
        message: "hi",
      })
    ).toEqual({ name: "Ali", email: "ali@example.com" })
  })

  it("returns nulls for missing or non-string values", () => {
    expect(getSubmissionSender({ name: 42, message: "hi" })).toEqual({
      name: null,
      email: null,
    })
    expect(getSubmissionSender(null)).toEqual({ name: null, email: null })
    expect(getSubmissionSender("not an object")).toEqual({
      name: null,
      email: null,
    })
  })

  it("trims whitespace and ignores blank strings", () => {
    expect(getSubmissionSender({ name: "  ", email: "  a@b.co  " })).toEqual({
      name: null,
      email: "a@b.co",
    })
  })
})

describe("previewSubmissionText", () => {
  it("prefers the message field", () => {
    expect(previewSubmissionText({ name: "Ali", message: "Hello there" })).toBe(
      "Hello there"
    )
  })

  it("falls back to the first string value and truncates long text", () => {
    expect(previewSubmissionText({ name: "Ali" })).toBe("Ali")
    expect(previewSubmissionText({ message: "x".repeat(100) })).toBe(
      `${"x".repeat(80)}…`
    )
    expect(previewSubmissionText(null)).toBe("—")
    expect(previewSubmissionText({ count: 3 })).toBe("—")
  })
})

describe("InboxListQuerySchema", () => {
  it("defaults to the all tab, page 1", () => {
    expect(InboxListQuerySchema.parse({})).toEqual({ tab: "all", page: 1 })
  })

  it("falls back to defaults for an unknown tab or bad page", () => {
    const parsed = InboxListQuerySchema.parse({ tab: "bogus", page: "abc" })
    expect(parsed.tab).toBe("all")
    expect(parsed.page).toBe(1)
  })

  it("rejects a malformed date", () => {
    expect(InboxListQuerySchema.safeParse({ from: "2026/11/01" }).success).toBe(
      false
    )
    expect(
      InboxListQuerySchema.parse({ from: "2026-11-01", to: "2026-11-30" })
    ).toMatchObject({ from: "2026-11-01", to: "2026-11-30" })
  })

  // DSH-202: shape-valid but impossible dates (Feb 30, month 13)
  // used to pass Zod, reach Postgres as a ::timestamptz cast, and
  // 500. They are a 422 now, at the validator and in the service.
  it("rejects impossible calendar dates", () => {
    expect(InboxListQuerySchema.safeParse({ from: "2026-02-30" }).success).toBe(
      false
    )
    expect(InboxListQuerySchema.safeParse({ from: "2026-13-01" }).success).toBe(
      false
    )
    expect(InboxListQuerySchema.safeParse({ to: "2026-02-30" }).success).toBe(
      false
    )
    expect(isValidCalendarDate("2026-02-28")).toBe(true)
    expect(isValidCalendarDate("2024-02-29")).toBe(true)
    expect(isValidCalendarDate("2026-02-29")).toBe(false)
    expect(isValidCalendarDate("2026-13-01")).toBe(false)
    expect(isValidCalendarDate("not-a-date")).toBe(false)
  })
})

describe("inbox action schemas", () => {
  it("accepts a single action and rejects an unknown one", () => {
    expect(UpdateSubmissionStatusSchema.parse({ action: "star" })).toEqual({
      action: "star",
    })
    expect(
      UpdateSubmissionStatusSchema.safeParse({ action: "explode" }).success
    ).toBe(false)
  })

  it("bulk requires 1-100 ids", () => {
    expect(
      BulkUpdateSubmissionsSchema.parse({ ids: ["a", "b"], action: "archive" })
    ).toEqual({ ids: ["a", "b"], action: "archive" })
    expect(
      BulkUpdateSubmissionsSchema.safeParse({ ids: [], action: "archive" })
        .success
    ).toBe(false)
    expect(
      BulkUpdateSubmissionsSchema.safeParse({
        ids: Array.from({ length: 101 }, (_, i) => `id-${i}`),
        action: "archive",
      }).success
    ).toBe(false)
  })
})

describe("SendReplySchema / DraftReplySchema (SRC-104)", () => {
  it("caps subject at 200 and body at 2000", () => {
    expect(
      SendReplySchema.safeParse({ subject: "Hi", body: "Hello" }).success
    ).toBe(true)
    expect(
      SendReplySchema.safeParse({ subject: "x".repeat(201), body: "Hello" })
        .success
    ).toBe(false)
    expect(
      SendReplySchema.safeParse({ subject: "Hi", body: "x".repeat(2001) })
        .success
    ).toBe(false)
    expect(
      SendReplySchema.safeParse({ subject: "Hi", body: "x".repeat(100000) })
        .success
    ).toBe(false)
  })

  it("draft-reply is the shared browser-key trio: key without provider fails", () => {
    expect(DraftReplySchema.safeParse({}).success).toBe(true)
    expect(
      DraftReplySchema.safeParse({
        browserKey: "sk-test",
        browserProvider: "openai",
      }).success
    ).toBe(true)
    const parsed = DraftReplySchema.safeParse({ browserKey: "sk-test" })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toBe(
        "A browser-only key needs its provider."
      )
    }
    expect(
      DraftReplySchema.safeParse({ browserKey: "x".repeat(501) }).success
    ).toBe(false)
  })
})
