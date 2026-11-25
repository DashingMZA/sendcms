import { describe, expect, it } from "vitest"
import { defaultFormFields } from "@sendcms/forms"
import {
  AddNotificationEmailSchema,
  CreateFieldSchema,
  CreateFormSchema,
  FormListQuerySchema,
  LinkDomainSchema,
  SuggestFieldsSchema,
  UpdateFieldSchema,
  UpdateFormSchema,
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

  it("accepts a relative redirect URL", () => {
    expect(
      CreateFormSchema.safeParse({
        name: "Contact",
        redirectUrl: "/thanks",
      }).success
    ).toBe(true)
  })

  it("rejects protocol-relative and javascript: redirect URLs", () => {
    for (const redirectUrl of [
      "//evil.example/thanks",
      "javascript:alert(1)",
    ]) {
      expect(
        CreateFormSchema.safeParse({ name: "Contact", redirectUrl }).success
      ).toBe(false)
    }
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

  // DSH-108: a PATCH carrying `name` must fail loudly instead of
  // being silently stripped (200, label updated, key kept, no error).
  it("rejects a rename with 'Field key cannot be changed.'", () => {
    const parsed = UpdateFieldSchema.safeParse({
      name: "renamed",
      label: "Topic Updated",
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toBe(
        "Field key cannot be changed."
      )
    }
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

describe("UpdateFormSchema", () => {
  it("accepts the AI opt-in flag and leaves it unset when omitted", () => {
    const enabled = UpdateFormSchema.safeParse({ aiEnabled: true })
    expect(enabled.success).toBe(true)
    if (enabled.success) expect(enabled.data.aiEnabled).toBe(true)
    const omitted = UpdateFormSchema.safeParse({})
    expect(omitted.success).toBe(true)
    if (omitted.success) expect(omitted.data.aiEnabled).toBeUndefined()
  })

  it("rejects a non-boolean AI opt-in flag", () => {
    expect(UpdateFormSchema.safeParse({ aiEnabled: "yes" }).success).toBe(false)
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

describe("FormListQuerySchema (DSH-107)", () => {
  it("honours limit as an alias for perPage", () => {
    const parsed = FormListQuerySchema.parse({ limit: "1", page: "2" })
    expect(parsed.perPage).toBe(1)
    expect(parsed.page).toBe(2)
  })

  it("prefers limit over perPage when both are given", () => {
    expect(
      FormListQuerySchema.parse({ limit: "5", perPage: "50" }).perPage
    ).toBe(5)
  })

  it("rejects perPage over 100 at the schema (the service clamps direct callers)", () => {
    expect(FormListQuerySchema.parse({ perPage: "50" }).perPage).toBe(50)
    expect(FormListQuerySchema.safeParse({ perPage: "500" }).success).toBe(
      false
    )
    expect(
      FormListQuerySchema.safeParse({ search: "x".repeat(201) }).success
    ).toBe(false)
  })
})

describe("SuggestFieldsSchema (SRC-104)", () => {
  it("accepts a prompt with a browser-only key + provider", () => {
    expect(
      SuggestFieldsSchema.safeParse({
        prompt: "Add a company field",
        browserKey: "sk-test",
        browserProvider: "openai",
      }).success
    ).toBe(true)
  })

  it("rejects a browser key without its provider", () => {
    const parsed = SuggestFieldsSchema.safeParse({
      prompt: "Add a company field",
      browserKey: "sk-test",
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toBe(
        "A browser-only key needs its provider."
      )
    }
  })

  it("rejects a prompt over 1000 chars", () => {
    expect(
      SuggestFieldsSchema.safeParse({ prompt: "x".repeat(1001) }).success
    ).toBe(false)
  })
})
