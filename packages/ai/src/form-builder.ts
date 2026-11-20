import { generateObject } from "ai"
import { z } from "zod"

import type { LanguageModel } from "ai"

// AI-assisted form building (Phase 12, Step 4). The model call only —
// the orchestration (ownership, the aiEnabled opt-in) lives in
// `@sendcms/forms`. The owner reviews the suggestions before any
// field is created (ADR 0010): this function returns suggestions, it
// never writes to the database.

export const FieldSuggestionSchema = z.object({
  /** Lowercase snake_case key, unique within the form. */
  name: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z][a-z0-9_]*$/, "name must be lowercase snake_case"),
  label: z.string().min(1).max(100),
  type: z.enum([
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
  ]),
  required: z.boolean(),
  placeholder: z.string().max(200).optional(),
  /** Option list for SELECT / CHECKBOX / RADIO. */
  options: z.array(z.string().max(100)).max(20).optional(),
})

export type FieldSuggestion = z.infer<typeof FieldSuggestionSchema>

export const FieldSuggestionsSchema = z.object({
  fields: z.array(FieldSuggestionSchema).min(1).max(20),
})

export type FieldSuggestions = z.infer<typeof FieldSuggestionsSchema>

/** Asks the model to suggest fields for a form described in plain
    language. Returns the suggestions — the caller shows them to the
    owner, who picks which to add. Throws when the provider call
    fails. */
export async function suggestFields({
  model,
  prompt,
  existingFields,
}: {
  model: LanguageModel
  prompt: string
  existingFields: { name: string; label: string; type: string }[]
}): Promise<FieldSuggestions> {
  const existing =
    existingFields.length > 0
      ? `The form already has these fields (do not suggest duplicates): ${existingFields
          .map((f) => `${f.name} (${f.type}, "${f.label}")`)
          .join(", ")}.`
      : "The form has no fields yet."
  const { object } = await generateObject({
    model,
    schema: FieldSuggestionsSchema,
    // One retry only (default is 2). This is an interactive call: the
    // dashboard's proxy to the api app gives up after ~30s, and the
    // SDK's 3-attempt backoff alone burns ~30s on an overloaded model.
    // A fast failure lets the owner retry at once; the worker paths
    // (spam re-score, digest) keep the default retries.
    maxRetries: 1,
    prompt: [
      "You are helping a website owner build a contact form.",
      "Suggest the fields for a form described below. Each field needs a lowercase snake_case name, a human-readable label, a type, and whether it is required.",
      "Use EMAIL for email addresses, TEXTAREA for long messages, TEL for phone numbers, URL for websites, NUMBER for quantities, DATE for dates, and SELECT / CHECKBOX / RADIO when the visitor must pick from a short list (include the options).",
      "Keep it to the fields the description actually asks for — no filler fields.",
      `Description: "${prompt}"`,
      existing,
    ].join("\n"),
  })
  // Validate at the boundary too: a malformed model reply must never
  // reach the form.
  return FieldSuggestionsSchema.parse(object)
}
