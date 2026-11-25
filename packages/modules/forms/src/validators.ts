import { z } from "zod"
import { HONEYPOT_FIELD } from "@sendcms/submissions/validators"
import { BrowserKeyOptionsSchema } from "@sendcms/ai-settings/validators"

export const FormFieldTypeSchema = z.enum([
  "TEXT",
  "EMAIL",
  "TEXTAREA",
  "NUMBER",
  "SELECT",
  "CHECKBOX",
  "RADIO",
  "URL",
  "TEL",
  "DATE",
])

const OPTION_TYPES = ["SELECT", "CHECKBOX", "RADIO"] as const

const FieldOptionsSchema = z
  .array(z.string().trim().min(1).max(100))
  .min(1, "Add at least one option")
  .max(50)

const fieldShape = {
  name: z
    .string()
    .min(1, "Enter a field key")
    .max(50)
    .regex(
      /^[a-zA-Z][a-zA-Z0-9_]*$/,
      "Field key must start with a letter and contain only letters, digits and _"
    )
    .refine((v) => v !== HONEYPOT_FIELD, {
      message: "This field key is reserved for spam protection",
    }),
  label: z.string().trim().min(1, "Enter a label").max(100),
  type: FormFieldTypeSchema,
  required: z.boolean().optional().default(false),
  placeholder: z.string().max(200).optional(),
  options: FieldOptionsSchema.optional(),
  minLength: z.number().int().min(0).max(10000).optional(),
  maxLength: z.number().int().min(0).max(10000).optional(),
  order: z.number().int().min(0).optional(),
}

// Options are only meaningful for SELECT / CHECKBOX / RADIO; other types
// must not carry them. Length bounds must not contradict each other.
// (Generic over the schema itself so the refined schema keeps the exact
// input type — a loose generic constraint would widen enums to `string`
// and drop `null` from nullable fields.)
type FieldRefineShape = {
  type: string
  options?: string[] | null
  minLength?: number | null
  maxLength?: number | null
}

function refineField<S extends z.ZodTypeAny>(schema: S) {
  // The refine callback receives output<S> (unknown while S is generic);
  // narrow it to the field shape inside.
  const asField = (v: unknown) => v as FieldRefineShape
  return schema
    .refine(
      (v) =>
        OPTION_TYPES.includes(
          asField(v).type as (typeof OPTION_TYPES)[number]
        ) || !asField(v).options,
      {
        message: "Options only apply to select, checkbox and radio fields",
        path: ["options"],
      }
    )
    .refine(
      (v) =>
        !OPTION_TYPES.includes(
          asField(v).type as (typeof OPTION_TYPES)[number]
        ) ||
        (Array.isArray(asField(v).options) && asField(v).options!.length > 0),
      {
        message: "Select, checkbox and radio fields need at least one option",
        path: ["options"],
      }
    )
    .refine(
      (v) =>
        asField(v).minLength == null ||
        asField(v).maxLength == null ||
        asField(v).minLength! <= asField(v).maxLength!,
      {
        message: "Minimum length must not exceed maximum length",
        path: ["minLength"],
      }
    )
}

export const CreateFieldSchema = refineField(z.object(fieldShape))

export type CreateFieldInput = z.infer<typeof CreateFieldSchema>

export const UpdateFieldSchema = refineField(
  z.object({
    // DSH-108: the field key is immutable — a PATCH carrying `name`
    // must fail loudly ("Field key cannot be changed.") instead of
    // being silently stripped by zod's default unknown-key behaviour
    // (200, label updated, key kept, no error).
    name: z
      .string()
      .optional()
      .refine((v) => v === undefined, {
        message: "Field key cannot be changed.",
      }),
    label: fieldShape.label.optional(),
    type: fieldShape.type.optional(),
    required: z.boolean().optional(),
    placeholder: z.string().max(200).optional().nullable(),
    options: FieldOptionsSchema.optional().nullable(),
    minLength: z.number().int().min(0).max(10000).optional().nullable(),
    maxLength: z.number().int().min(0).max(10000).optional().nullable(),
    order: z.number().int().min(0).optional(),
  })
)

export type UpdateFieldInput = z.infer<typeof UpdateFieldSchema>

// A redirect target is either a same-site relative path or an absolute
// http(s) URL. Anything else (ftp:, javascript:, protocol-relative
// `//host`, bare hostnames) is rejected. Whether the absolute host is
// one the owner controls is enforced in the service (SEC-210).
const RedirectUrlSchema = z.string().refine(
  (v) => {
    const value = v.trim()
    if (value.startsWith("/") && !value.startsWith("//")) return true
    try {
      const scheme = new URL(value).protocol
      return scheme === "http:" || scheme === "https:"
    } catch {
      return false
    }
  },
  {
    message: "Redirect URL must be a relative path or a valid http(s) URL",
  }
)

export const CreateFormSchema = z.object({
  name: z.string().trim().min(1, "Enter a form name").max(100),
  description: z.string().max(500).optional(),
  successMessage: z.string().max(500).optional(),
  redirectUrl: RedirectUrlSchema.optional(),
  honeypotEnabled: z.boolean().optional().default(true),
  turnstileEnabled: z.boolean().optional().default(false),
  dailyLimit: z.number().int().min(1).max(100000).optional(),
})

export type CreateFormInput = z.infer<typeof CreateFormSchema>

export const UpdateFormSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  active: z.boolean().optional(),
  successMessage: z.string().max(500).optional().nullable(),
  redirectUrl: RedirectUrlSchema.optional().nullable(),
  honeypotEnabled: z.boolean().optional(),
  turnstileEnabled: z.boolean().optional(),
  // Phase 12: per-form AI opt-in. Default OFF (DB default false) — no
  // submission content reaches a model provider unless the owner
  // enables AI for this form.
  aiEnabled: z.boolean().optional(),
  // Phase 16 (EML-093): per-form digest opt-in, decoupled from
  // `aiEnabled` — the digest is a notification preference. Interval
  // in hours (24 = daily, 168 = weekly); null resets to the platform
  // default. Bounded 1–720 (one hour to thirty days).
  digestEnabled: z.boolean().optional(),
  digestIntervalHours: z.number().int().min(1).max(720).optional().nullable(),
  dailyLimit: z.number().int().min(1).max(100000).optional().nullable(),
})

export type UpdateFormInput = z.infer<typeof UpdateFormSchema>

export const LinkDomainSchema = z.object({
  domainId: z.string().min(1, "Choose a domain"),
})

export type LinkDomainInput = z.infer<typeof LinkDomainSchema>

export const AddNotificationEmailSchema = z.object({
  email: z.string().email("Enter a valid email address"),
})

export type AddNotificationEmailInput = z.infer<
  typeof AddNotificationEmailSchema
>

export const UpdateNotificationEmailSchema = z.object({
  enabled: z.boolean(),
})

export type UpdateNotificationEmailInput = z.infer<
  typeof UpdateNotificationEmailSchema
>

// DSH-107: the forms list query — same contract as the domains list
// (see @sendcms/domains validators): `limit` is an alias for
// `perPage`; when both are given, `limit` wins. Unknown params are
// rejected by the route's safeParse instead of silently dropped
// (strict).
export const FormListQuerySchema = z
  .object({
    search: z.string().trim().min(1).max(200).optional(),
    page: z.coerce.number().int().min(1).default(1),
    perPage: z.coerce.number().int().min(1).max(100).default(20),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    sortBy: z.enum(["createdAt", "name"]).default("createdAt"),
    sortDir: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict()
  .transform((v) => ({
    search: v.search,
    page: v.page,
    perPage: v.limit ?? v.perPage,
    sortBy: v.sortBy,
    sortDir: v.sortDir,
  }))

export type FormListQueryInput = z.infer<typeof FormListQuerySchema>

// SRC-104: the suggest-fields body, validated with Zod instead of
// the route's hand-rolled prompt/browser-key block. The prompt cap
// (1000) is the route's old inline check; the browser-key trio is
// the shared BrowserKeyOptionsSchema (a key without its provider
// 422s with "A browser-only key needs its provider.").
export const SuggestFieldsSchema = BrowserKeyOptionsSchema.extend({
  prompt: z
    .string()
    .trim()
    .min(1, "A description is required.")
    .max(1000, "Description is too long."),
})

export type SuggestFieldsInput = z.infer<typeof SuggestFieldsSchema>
