import { z } from "zod"

// Client-side validation for the (auth) forms. The server (Better Auth)
// enforces the same rules — these only give the user an early, readable
// error. Keep min/max lengths in sync with lib/auth.ts (minPasswordLength
// 8, maxPasswordLength 128).

export const SignUpSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  email: z.string().email("Enter a valid email address"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128),
})

export const SignInSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
})

export const ForgotPasswordSchema = z.object({
  email: z.string().email("Enter a valid email address"),
})

export const ResetPasswordSchema = z.object({
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(128),
})

export const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .max(128),
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: "New password must be different from the current one",
    path: ["newPassword"],
  })

export const UpdateProfileSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
})

export const ChangeEmailSchema = z.object({
  email: z.string().email("Enter a valid email address"),
})

export type SignUpInput = z.infer<typeof SignUpSchema>
export type SignInInput = z.infer<typeof SignInSchema>
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>
export type UpdateProfileInput = z.infer<typeof UpdateProfileSchema>
export type ChangeEmailInput = z.infer<typeof ChangeEmailSchema>
