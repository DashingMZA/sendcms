"use client"

import { useState } from "react"
import {
  useAddField,
  useDeleteField,
  useSuggestFields,
  useUpdateField,
  type AiFieldSuggestion,
} from "@sendcms/forms/queries"
import type { FormDetail } from "@sendcms/forms/queries"
import type { CreateFieldInput } from "@sendcms/forms/validators"
import { ApiClientError } from "@sendcms/shared"

import {
  Badge,
  Button,
  Checkbox,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@sendcms/ui"

import type { FormField, FormFieldType } from "@sendcms/database"

const FIELD_TYPES: FormFieldType[] = [
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
]

const OPTION_TYPES: FormFieldType[] = ["SELECT", "CHECKBOX", "RADIO"]

const TYPE_LABEL: Record<FormFieldType, string> = {
  TEXT: "Text",
  EMAIL: "Email",
  TEXTAREA: "Long text",
  NUMBER: "Number",
  SELECT: "Dropdown",
  CHECKBOX: "Checkboxes",
  RADIO: "Radio buttons",
  URL: "URL",
  TEL: "Phone",
  DATE: "Date",
}

function optionsFromText(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
}

function FieldForm({
  formId,
  field,
  onDone,
}: {
  formId: string
  field?: FormField
  onDone: () => void
}) {
  const addField = useAddField(formId)
  const updateField = useUpdateField(formId, field?.id ?? "")
  const [name, setName] = useState(field?.name ?? "")
  const [label, setLabel] = useState(field?.label ?? "")
  const [type, setType] = useState<FormFieldType>(field?.type ?? "TEXT")
  const [required, setRequired] = useState(field?.required ?? false)
  const [placeholder, setPlaceholder] = useState(field?.placeholder ?? "")
  const [optionsText, setOptionsText] = useState(
    Array.isArray(field?.options) ? (field.options as string[]).join("\n") : ""
  )
  const [minLength, setMinLength] = useState(
    field?.minLength != null ? String(field.minLength) : ""
  )
  const [maxLength, setMaxLength] = useState(
    field?.maxLength != null ? String(field.maxLength) : ""
  )
  const [error, setError] = useState<string | null>(null)
  const pending = addField.isPending || updateField.isPending

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    const options = OPTION_TYPES.includes(type)
      ? optionsFromText(optionsText)
      : undefined
    try {
      if (field) {
        await updateField.mutateAsync({
          label,
          type,
          required,
          placeholder: placeholder || null,
          options: options ?? null,
          minLength: minLength ? Number(minLength) : null,
          maxLength: maxLength ? Number(maxLength) : null,
        })
      } else {
        const body: CreateFieldInput = {
          name,
          label,
          type,
          required,
          placeholder: placeholder || undefined,
          options,
          minLength: minLength ? Number(minLength) : undefined,
          maxLength: maxLength ? Number(maxLength) : undefined,
        }
        await addField.mutateAsync(body)
      }
      onDone()
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Could not save this field."
      )
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-4 rounded-lg border p-4"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={field ? `key-${field.id}` : "key"}>Field key</Label>
          <Input
            id={field ? `key-${field.id}` : "key"}
            autoComplete="off"
            placeholder="email"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!!field}
            required
          />
          <p className="text-xs text-muted-foreground">
            The key in the submission payload. It cannot be changed later.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor={field ? `label-${field.id}` : "label"}>Label</Label>
          <Input
            id={field ? `label-${field.id}` : "label"}
            autoComplete="off"
            placeholder="Your email"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={field ? `type-${field.id}` : "type"}>Type</Label>
          <Select
            value={type}
            onValueChange={(v) => setType(v as FormFieldType)}
          >
            <SelectTrigger id={field ? `type-${field.id}` : "type"}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FIELD_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {TYPE_LABEL[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={field ? `placeholder-${field.id}` : "placeholder"}>
            Placeholder (optional)
          </Label>
          <Input
            id={field ? `placeholder-${field.id}` : "placeholder"}
            autoComplete="off"
            value={placeholder}
            onChange={(e) => setPlaceholder(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={field ? `min-${field.id}` : "min"}>Min length</Label>
          <Input
            id={field ? `min-${field.id}` : "min"}
            type="number"
            min={0}
            max={10000}
            value={minLength}
            onChange={(e) => setMinLength(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={field ? `max-${field.id}` : "max"}>Max length</Label>
          <Input
            id={field ? `max-${field.id}` : "max"}
            type="number"
            min={0}
            max={10000}
            value={maxLength}
            onChange={(e) => setMaxLength(e.target.value)}
          />
        </div>
      </div>
      {OPTION_TYPES.includes(type) && (
        <div className="space-y-2">
          <Label htmlFor={field ? `options-${field.id}` : "options"}>
            Options (one per line)
          </Label>
          <Textarea
            id={field ? `options-${field.id}` : "options"}
            rows={3}
            placeholder={"General\nSupport\nSales"}
            value={optionsText}
            onChange={(e) => setOptionsText(e.target.value)}
          />
        </div>
      )}
      <div className="flex items-center gap-2">
        <Checkbox
          id={field ? `required-${field.id}` : "required"}
          checked={required}
          onCheckedChange={(v) => setRequired(v === true)}
        />
        <Label htmlFor={field ? `required-${field.id}` : "required"}>
          Required
        </Label>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : field ? "Save field" : "Add field"}
        </Button>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

export function FieldsSection({ form }: { form: FormDetail }) {
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="flex flex-col gap-4">
      {form.aiEnabled && <AiFieldsPanel form={form} />}
      {form.fields.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No fields yet — add one below.
        </p>
      )}
      {form.fields.map((field) => (
        <div key={field.id} className="rounded-lg border">
          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            <span className="font-medium">{field.label}</span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {field.name}
            </code>
            <Badge variant="secondary">{TYPE_LABEL[field.type]}</Badge>
            {field.required && <Badge>Required</Badge>}
            {Array.isArray(field.options) && (
              <span className="text-xs text-muted-foreground">
                {(field.options as string[]).join(", ")}
              </span>
            )}
            <span className="ml-auto flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setEditingId(editingId === field.id ? null : field.id)
                }
              >
                {editingId === field.id ? "Close" : "Edit"}
              </Button>
              <DeleteFieldButton
                formId={form.id}
                field={field}
                onError={setError}
              />
            </span>
          </div>
          {editingId === field.id && (
            <div className="border-t p-4">
              <FieldForm
                formId={form.id}
                field={field}
                onDone={() => setEditingId(null)}
              />
            </div>
          )}
        </div>
      ))}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {adding ? (
        <FieldForm formId={form.id} onDone={() => setAdding(false)} />
      ) : (
        <div>
          <Button variant="outline" onClick={() => setAdding(true)}>
            Add field
          </Button>
        </div>
      )}
    </div>
  )
}

function DeleteFieldButton({
  formId,
  field,
  onError,
}: {
  formId: string
  field: FormField
  onError: (msg: string | null) => void
}) {
  const remove = useDeleteField(formId, field.id)
  return (
    <Button
      variant="destructive"
      size="sm"
      disabled={remove.isPending}
      onClick={async () => {
        if (!confirm(`Delete the "${field.label}" field?`)) return
        onError(null)
        try {
          await remove.mutateAsync()
        } catch (err) {
          onError(
            err instanceof ApiClientError
              ? err.message
              : "Could not delete this field."
          )
        }
      }}
    >
      Delete
    </Button>
  )
}

/** AI-assisted form building (Phase 12, Step 4). The owner describes
    the form, the model suggests fields, and the owner reviews them
    here before any field is created — nothing is added until the owner
    picks fields and clicks "Add selected fields". */
function AiFieldsPanel({ form }: { form: FormDetail }) {
  const [prompt, setPrompt] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [added, setAdded] = useState(0)
  const suggest = useSuggestFields(form.id)
  const addField = useAddField(form.id)

  const suggestions = suggest.data?.fields ?? []
  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const onSuggest = async () => {
    setError(null)
    setAdded(0)
    try {
      const result = await suggest.mutateAsync(prompt)
      setSelected(new Set(result.fields.map((f) => f.name)))
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? err.message
          : "Could not suggest fields."
      )
    }
  }

  const onAddSelected = async () => {
    setError(null)
    const chosen = suggestions.filter((f) => selected.has(f.name))
    let count = 0
    for (const [i, field] of chosen.entries()) {
      try {
        await addField.mutateAsync({
          name: field.name,
          label: field.label,
          type: field.type,
          required: field.required,
          placeholder: field.placeholder,
          options: field.options,
          order: form.fields.length + i,
        })
        count++
      } catch (err) {
        setError(
          err instanceof ApiClientError
            ? err.message
            : `Could not add field "${field.label}".`
        )
        break
      }
    }
    setAdded(count)
    if (count === chosen.length) {
      suggest.reset()
      setPrompt("")
      setSelected(new Set())
    }
  }

  return (
    <div className="rounded-lg border p-4">
      <p className="font-medium">Build with AI</p>
      <p className="text-sm text-muted-foreground">
        Describe the form in plain language and the AI will suggest fields.
        Nothing is added until you review and pick them.
      </p>
      <div className="mt-3 flex flex-col gap-2">
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. A contact form with name, email, and a message, plus a dropdown for the reason they are writing"
          rows={2}
        />
        <div>
          <Button
            variant="outline"
            onClick={onSuggest}
            disabled={!prompt.trim() || suggest.isPending}
          >
            {suggest.isPending ? "Suggesting…" : "Suggest fields"}
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {added > 0 && (
        <p className="mt-2 text-sm text-muted-foreground">
          Added {added} field{added === 1 ? "" : "s"}.
        </p>
      )}
      {suggestions.length > 0 && (
        <div className="mt-3 flex flex-col gap-2">
          {suggestions.map((field: AiFieldSuggestion) => (
            <label
              key={field.name}
              className="flex items-start gap-2 rounded border px-3 py-2"
            >
              <Checkbox
                checked={selected.has(field.name)}
                onCheckedChange={() => toggle(field.name)}
              />
              <span>
                <span className="font-medium">{field.label}</span>{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                  {field.name}
                </code>{" "}
                <Badge variant="secondary">{TYPE_LABEL[field.type]}</Badge>{" "}
                {field.required && <Badge>Required</Badge>}
                {field.options && (
                  <span className="text-xs text-muted-foreground">
                    {field.options.join(", ")}
                  </span>
                )}
              </span>
            </label>
          ))}
          <div>
            <Button
              onClick={onAddSelected}
              disabled={selected.size === 0 || addField.isPending}
            >
              {addField.isPending
                ? "Adding…"
                : `Add selected field${selected.size === 1 ? "" : "s"} (${selected.size})`}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
