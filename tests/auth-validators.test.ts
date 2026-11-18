import { describe, expect, it } from "vitest"
import {
  ChangeEmailSchema,
  ChangePasswordSchema,
  ForgotPasswordSchema,
  ResetPasswordSchema,
  SignInSchema,
  SignUpSchema,
  UpdateProfileSchema,
} from "@sendcms/users/validators"

describe("SignUpSchema", () => {
  it("accepts a valid sign-up", () => {
    expect(
      SignUpSchema.safeParse({
        name: "Zaheer",
        email: "zaheer@example.com",
        password: "correct horse battery staple",
      }).success
    ).toBe(true)
  })

  it("rejects a bad email, short password and blank name", () => {
    expect(
      SignUpSchema.safeParse({
        name: "  ",
        email: "not-an-email",
        password: "short",
      }).success
    ).toBe(false)
    expect(
      SignUpSchema.safeParse({
        name: "Zaheer",
        email: "zaheer@example.com",
        password: "short",
      }).success
    ).toBe(false)
  })

  it("trims the name", () => {
    const parsed = SignUpSchema.safeParse({
      name: "  Zaheer  ",
      email: "zaheer@example.com",
      password: "long-enough-password",
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.name).toBe("Zaheer")
  })
})

describe("SignInSchema", () => {
  it("accepts email + password and rejects a bad email", () => {
    expect(
      SignInSchema.safeParse({ email: "a@b.co", password: "x" }).success
    ).toBe(true)
    expect(
      SignInSchema.safeParse({ email: "nope", password: "x" }).success
    ).toBe(false)
  })
})

describe("ForgotPasswordSchema / ResetPasswordSchema", () => {
  it("validates the email and the new password length", () => {
    expect(ForgotPasswordSchema.safeParse({ email: "a@b.co" }).success).toBe(
      true
    )
    expect(ForgotPasswordSchema.safeParse({ email: "nope" }).success).toBe(
      false
    )
    expect(
      ResetPasswordSchema.safeParse({ password: "long-enough" }).success
    ).toBe(true)
    expect(ResetPasswordSchema.safeParse({ password: "short" }).success).toBe(
      false
    )
  })
})

describe("ChangePasswordSchema", () => {
  it("rejects a new password identical to the current one", () => {
    const parsed = ChangePasswordSchema.safeParse({
      currentPassword: "same-password",
      newPassword: "same-password",
    })
    expect(parsed.success).toBe(false)
  })

  it("accepts a different, long-enough new password", () => {
    expect(
      ChangePasswordSchema.safeParse({
        currentPassword: "old-password",
        newPassword: "new-password-123",
      }).success
    ).toBe(true)
  })
})

describe("UpdateProfileSchema / ChangeEmailSchema", () => {
  it("requires a non-blank name and a valid email", () => {
    expect(UpdateProfileSchema.safeParse({ name: "  " }).success).toBe(false)
    expect(UpdateProfileSchema.safeParse({ name: "Zaheer" }).success).toBe(true)
    expect(
      ChangeEmailSchema.safeParse({ email: "new@example.com" }).success
    ).toBe(true)
    expect(ChangeEmailSchema.safeParse({ email: "nope" }).success).toBe(false)
  })
})
