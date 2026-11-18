import { describe, expect, it } from "vitest"
import {
  computeContentHash,
  detectSpam,
  getOriginHost,
  isOriginAllowedForForm,
  sanitizeString,
  validateSubmissionFields,
} from "@/lib/services/submission-service"
import { CreateFieldSchema } from "@/lib/validators/form"
import type { FormField } from "@sendcms/database"

function field(overrides: Partial<FormField>): FormField {
  return {
    id: "field-1",
    name: "email",
    label: "Email",
    type: "EMAIL",
    required: true,
    placeholder: null,
    options: null,
    minLength: null,
    maxLength: null,
    order: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    formId: "form-1",
    ...overrides,
  }
}

describe("sanitizeString", () => {
  it("trims and strips control characters but keeps newlines", () => {
    expect(sanitizeString("  hello\x00\nworld\x07  ")).toBe("hello\nworld")
  })
})

describe("validateSubmissionFields", () => {
  const configs = [
    field({ name: "name", label: "Name", type: "TEXT", required: true }),
    field({ name: "email", label: "Email", type: "EMAIL", required: true }),
    field({
      name: "message",
      label: "Message",
      type: "TEXTAREA",
      required: true,
      minLength: 5,
      maxLength: 100,
    }),
    field({
      name: "topic",
      label: "Topic",
      type: "SELECT",
      required: false,
      options: ["General", "Support"],
    }),
  ]

  it("accepts a valid payload and trims values", () => {
    const out = validateSubmissionFields(
      {
        name: "  Ali  ",
        email: "ali@example.com",
        message: "Hello there",
        topic: "Support",
      },
      configs
    )
    expect(out).toEqual({
      name: "Ali",
      email: "ali@example.com",
      message: "Hello there",
      topic: "Support",
    })
  })

  it("rejects a missing required field", () => {
    expect(() =>
      validateSubmissionFields({ name: "Ali", message: "Hello there" }, configs)
    ).toThrow(/"Email" is required/)
  })

  it("rejects an unknown field", () => {
    expect(() =>
      validateSubmissionFields(
        {
          name: "Ali",
          email: "ali@example.com",
          message: "Hello there",
          injected: "x",
        },
        configs
      )
    ).toThrow(/Unknown field: "injected"/)
  })

  it("rejects a bad email and an out-of-list option", () => {
    expect(() =>
      validateSubmissionFields(
        { name: "Ali", email: "not-an-email", message: "Hello there" },
        configs
      )
    ).toThrow(/must be a valid email/)
    expect(() =>
      validateSubmissionFields(
        {
          name: "Ali",
          email: "ali@example.com",
          message: "Hello there",
          topic: "Billing",
        },
        configs
      )
    ).toThrow(/must be one of/)
  })

  it("enforces min/max length", () => {
    expect(() =>
      validateSubmissionFields(
        { name: "Ali", email: "ali@example.com", message: "Hi" },
        configs
      )
    ).toThrow(/at least 5 characters/)
  })

  it("validates numbers and checkboxes", () => {
    const numConfigs = [
      field({ name: "age", label: "Age", type: "NUMBER", required: true }),
      field({
        name: "interests",
        label: "Interests",
        type: "CHECKBOX",
        required: false,
        options: ["a", "b"],
      }),
    ]
    expect(
      validateSubmissionFields({ age: "42", interests: ["a", "b"] }, numConfigs)
    ).toEqual({ age: 42, interests: ["a", "b"] })
    expect(() =>
      validateSubmissionFields({ age: "forty-two" }, numConfigs)
    ).toThrow(/must be a number/)
    expect(() =>
      validateSubmissionFields({ age: 30, interests: ["c"] }, numConfigs)
    ).toThrow(/must be one of/)
  })

  it("rejects the reserved honeypot field key", () => {
    expect(
      CreateFieldSchema.safeParse({
        name: "_sendcms_honeypot",
        label: "Trap",
        type: "TEXT",
      }).success
    ).toBe(false)
  })
})

describe("computeContentHash", () => {
  it("is stable regardless of key order and changes with content", () => {
    const a = computeContentHash("form-1", { b: "2", a: "1" })
    const b = computeContentHash("form-1", { a: "1", b: "2" })
    const c = computeContentHash("form-1", { a: "1", b: "3" })
    const d = computeContentHash("form-2", { a: "1", b: "2" })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).not.toBe(d)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("detectSpam", () => {
  it("flags many links and keyword stuffing, passes normal text", () => {
    expect(
      detectSpam({
        message: "see https://a.com https://b.com https://c.com https://d.com",
      })
    ).toContain("too many links")
    expect(detectSpam({ message: "hello world, please help me" })).toEqual([])
    expect(
      detectSpam({
        message: "cheap cheap cheap cheap cheap cheap cheap cheap cheap cheap",
      })
    ).toContain("repeated content")
  })
})

describe("getOriginHost / isOriginAllowedForForm", () => {
  it("normalizes origins (www stripped, case-insensitive)", () => {
    expect(getOriginHost("https://WWW.Example.com:443/")).toBe("example.com")
    expect(getOriginHost("not a url")).toBe(null)
    expect(getOriginHost(null)).toBe(null)
  })

  it("allows only linked VERIFIED domains, exact match", () => {
    const form = {
      domainLinks: [
        {
          domain: { domain: "example.com", status: "VERIFIED" },
        },
        {
          domain: { domain: "pending.com", status: "PENDING" },
        },
      ],
    } as never
    expect(isOriginAllowedForForm(form, "https://example.com")).toBe(true)
    expect(isOriginAllowedForForm(form, "https://www.example.com")).toBe(true)
    expect(isOriginAllowedForForm(form, "https://sub.example.com")).toBe(false)
    expect(isOriginAllowedForForm(form, "https://pending.com")).toBe(false)
    expect(isOriginAllowedForForm(form, "https://evil.com")).toBe(false)
    expect(isOriginAllowedForForm(form, null)).toBe(false)
  })
})
