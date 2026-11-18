import { describe, expect, it } from "vitest"
import {
  SubmitBodySchema,
  formDataToSubmitBody,
} from "@sendcms/submissions/validators"

describe("formDataToSubmitBody (no-JS fallback)", () => {
  it("splits top-level keys from submission fields", () => {
    const fd = new FormData()
    fd.append("userId", "user-1")
    fd.append("formId", "form-1")
    fd.append("name", "Ali")
    fd.append("email", "ali@example.com")
    fd.append("message", "Hello")
    fd.append("_sendcms_honeypot", "")
    const body = formDataToSubmitBody(fd)
    expect(SubmitBodySchema.safeParse(body).success).toBe(true)
    expect(body).toEqual({
      userId: "user-1",
      formId: "form-1",
      _sendcms_honeypot: "",
      fields: { name: "Ali", email: "ali@example.com", message: "Hello" },
    })
  })

  it("collects repeated keys into arrays (checkbox groups)", () => {
    const fd = new FormData()
    fd.append("userId", "user-1")
    fd.append("formId", "form-1")
    fd.append("interests", "a")
    fd.append("interests", "b")
    const body = formDataToSubmitBody(fd)
    expect(body.fields).toEqual({ interests: ["a", "b"] })
    expect(SubmitBodySchema.safeParse(body).success).toBe(true)
  })

  it("drops file values and keeps the body valid", () => {
    const fd = new FormData()
    fd.append("userId", "user-1")
    fd.append("formId", "form-1")
    fd.append("name", "Ali")
    fd.append("attachment", new File(["x"], "x.txt"))
    const body = formDataToSubmitBody(fd)
    expect(body.fields).toEqual({ name: "Ali" })
    expect(SubmitBodySchema.safeParse(body).success).toBe(true)
  })

  it("fails validation when the ids are missing", () => {
    const fd = new FormData()
    fd.append("name", "Ali")
    const body = formDataToSubmitBody(fd)
    expect(SubmitBodySchema.safeParse(body).success).toBe(false)
  })
})
