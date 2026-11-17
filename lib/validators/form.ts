import { z } from "zod"

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
    ),
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

export const CreateFormSchema = z.object({
  name: z.string().trim().min(1, "Enter a form name").max(100),
  description: z.string().max(500).optional(),
  successMessage: z.string().max(500).optional(),
  redirectUrl: z
    .string()
    .url("Redirect URL must be a valid http(s) URL")
    .refine((v) => v.startsWith("http://") || v.startsWith("https://"), {
      message: "Redirect URL must start with http:// or https://",
    })
    .optional(),
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
  redirectUrl: z
    .string()
    .url("Redirect URL must be a valid http(s) URL")
    .refine((v) => v.startsWith("http://") || v.startsWith("https://"), {
      message: "Redirect URL must start with http:// or https://",
    })
    .optional()
    .nullable(),
  honeypotEnabled: z.boolean().optional(),
  turnstileEnabled: z.boolean().optional(),
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
