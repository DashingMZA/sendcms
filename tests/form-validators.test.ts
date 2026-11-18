import { describe, expect, it } from "vitest"
import { defaultFormFields } from "@sendcms/forms"
import {
  AddNotificationEmailSchema,
  CreateFieldSchema,
  CreateFormSchema,
  LinkDomainSchema,
  UpdateFieldSchema,
} from "@sendcms/forms/validators"

describe("CreateFormSchema", () => {
  it("accepts a minimal form", () => {
    const parsed = CreateFormSchema.safeParse({ name: "Contact" })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.honeypotEnabled).toBe(true)
      expect(parsed.data.turnstileEnabled).toBe(false)
    }
  })

  it("rejects an empty name", () => {
    expect(CreateFormSchema.safeParse({ name: "  " }).success).toBe(false)
  })

  it("rejects a non-http redirect URL", () => {
    expect(
      CreateFormSchema.safeParse({
        name: "Contact",
        redirectUrl: "ftp://example.com/thanks",
      }).success
    ).toBe(false)
  })

  it("accepts an https redirect URL", () => {
    expect(
      CreateFormSchema.safeParse({
        name: "Contact",
        redirectUrl: "https://example.com/thanks",
      }).success
    ).toBe(true)
  })

  it("rejects a daily limit below 1", () => {
    expect(
      CreateFormSchema.safeParse({ name: "Contact", dailyLimit: 0 }).success
    ).toBe(false)
  })
})

describe("CreateFieldSchema", () => {
  const base = { name: "email", label: "Email", type: "EMAIL" as const }

  it("accepts a plain field", () => {
    expect(CreateFieldSchema.safeParse(base).success).toBe(true)
  })

  it("rejects a field key with spaces or dashes", () => {
    expect(
      CreateFieldSchema.safeParse({ ...base, name: "your-name" }).success
    ).toBe(false)
    expect(
      CreateFieldSchema.safeParse({ ...base, name: "1email" }).success
    ).toBe(false)
  })

  it("requires options for select/radio/checkbox", () => {
    expect(
      CreateFieldSchema.safeParse({
        name: "topic",
        label: "Topic",
        type: "SELECT",
      }).success
    ).toBe(false)
    expect(
      CreateFieldSchema.safeParse({
        name: "topic",
        label: "Topic",
        type: "SELECT",
        options: ["General", "Support"],
      }).success
    ).toBe(true)
  })

  it("forbids options on text fields", () => {
    expect(
      CreateFieldSchema.safeParse({
        ...base,
        type: "TEXT",
        options: ["a"],
      }).success
    ).toBe(false)
  })

  it("rejects minLength above maxLength", () => {
    expect(
      CreateFieldSchema.safeParse({
        ...base,
        minLength: 10,
        maxLength: 5,
      }).success
    ).toBe(false)
  })
})

describe("UpdateFieldSchema", () => {
  it("accepts a partial update", () => {
    expect(UpdateFieldSchema.safeParse({ label: "Your email" }).success).toBe(
      true
    )
  })

  it("accepts clearing options with null", () => {
    expect(
      UpdateFieldSchema.safeParse({ type: "TEXT", options: null }).success
    ).toBe(true)
  })
})

describe("LinkDomainSchema / AddNotificationEmailSchema", () => {
  it("requires a domain id", () => {
    expect(LinkDomainSchema.safeParse({}).success).toBe(false)
    expect(LinkDomainSchema.safeParse({ domainId: "cm123" }).success).toBe(true)
  })

  it("rejects an invalid notification email", () => {
    expect(
      AddNotificationEmailSchema.safeParse({ email: "not-an-email" }).success
    ).toBe(false)
    expect(
      AddNotificationEmailSchema.safeParse({ email: "owner@example.com" })
        .success
    ).toBe(true)
  })
})

describe("defaultFormFields", () => {
  it("creates name, email and message — all required, in order", () => {
    const fields = defaultFormFields()
    expect(fields.map((f) => f.name)).toEqual(["name", "email", "message"])
    expect(fields.map((f) => f.type)).toEqual(["TEXT", "EMAIL", "TEXTAREA"])
    expect(fields.every((f) => f.required)).toBe(true)
    expect(fields.map((f) => f.order)).toEqual([0, 1, 2])
  })
})
