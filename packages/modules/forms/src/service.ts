import {
  AuditAction,
  AuditResource,
  DomainStatus,
  FormFieldType,
  Prisma,
  db,
} from "@sendcms/database"

import { ApiError } from "@sendcms/shared"

import { logAudit } from "@sendcms/security"
import {
  getAiModel,
  isAiConfigured,
  suggestFields,
  type FieldSuggestions,
} from "@sendcms/ai"

import type {
  AddNotificationEmailInput,
  CreateFieldInput,
  CreateFormInput,
  LinkDomainInput,
  UpdateFieldInput,
  UpdateFormInput,
  UpdateNotificationEmailInput,
} from "./validators"

// Forms (Phase 4). A form's `id` IS its public `formId`, used together
// with the owner's public `userId` (User.id) by the SDK / REST API
// (Phase 5/6). A form only accepts submissions from domains it is linked
// to — and only VERIFIED domains can be linked.

export function defaultFormFields(): CreateFieldInput[] {
  return [
    {
      name: "name",
      label: "Name",
      type: FormFieldType.TEXT,
      required: true,
      order: 0,
    },
    {
      name: "email",
      label: "Email",
      type: FormFieldType.EMAIL,
      required: true,
      order: 1,
    },
    {
      name: "message",
      label: "Message",
      type: FormFieldType.TEXTAREA,
      required: true,
      order: 2,
    },
  ]
}

async function getOwnedFormOrThrow(userId: string, formId: string) {
  const form = await db.form.findFirst({
    where: { id: formId, ownerId: userId },
    include: {
      fields: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] },
      domainLinks: {
        include: { domain: true },
        orderBy: { createdAt: "asc" },
      },
      notificationSettings: { orderBy: { createdAt: "asc" } },
      _count: { select: { submissions: true } },
    },
  })
  if (!form) throw new ApiError("Form not found", 404)
  return form
}

export async function getFormCountForUser(userId: string) {
  return db.form.count({ where: { ownerId: userId } })
}

export async function listFormsForUser(userId: string) {
  return db.form.findMany({
    where: { ownerId: userId },
    include: {
      _count: {
        select: { fields: true, domainLinks: true, submissions: true },
      },
    },
    orderBy: { createdAt: "desc" },
  })
}

export type FormWithCounts = Awaited<
  ReturnType<typeof listFormsForUser>
>[number]

export async function getFormForUser(userId: string, formId: string) {
  return getOwnedFormOrThrow(userId, formId)
}

export type FormDetail = Awaited<ReturnType<typeof getFormForUser>>

export async function createFormForUser(
  userId: string,
  input: CreateFormInput
) {
  const created = await db.form.create({
    data: {
      name: input.name,
      description: input.description,
      successMessage: input.successMessage,
      redirectUrl: input.redirectUrl,
      honeypotEnabled: input.honeypotEnabled ?? true,
      turnstileEnabled: input.turnstileEnabled ?? false,
      dailyLimit: input.dailyLimit,
      ownerId: userId,
      fields: { create: defaultFormFields() },
    },
    include: {
      fields: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] },
      domainLinks: { include: { domain: true } },
      notificationSettings: true,
      _count: { select: { submissions: true } },
    },
  })
  await logAudit({
    userId,
    action: AuditAction.CREATE,
    resourceType: AuditResource.FORM,
    resourceId: created.id,
    detail: {
      name: created.name,
    },
  })
  return created
}

export async function updateFormForUser(
  userId: string,
  formId: string,
  input: UpdateFormInput
) {
  const form = await getOwnedFormOrThrow(userId, formId)
  const updated = await db.form.update({
    where: { id: form.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.successMessage !== undefined
        ? { successMessage: input.successMessage }
        : {}),
      ...(input.redirectUrl !== undefined
        ? { redirectUrl: input.redirectUrl }
        : {}),
      ...(input.honeypotEnabled !== undefined
        ? { honeypotEnabled: input.honeypotEnabled }
        : {}),
      ...(input.turnstileEnabled !== undefined
        ? { turnstileEnabled: input.turnstileEnabled }
        : {}),
      ...(input.aiEnabled !== undefined ? { aiEnabled: input.aiEnabled } : {}),
      ...(input.dailyLimit !== undefined
        ? { dailyLimit: input.dailyLimit }
        : {}),
    },
    include: {
      fields: { orderBy: [{ order: "asc" }, { createdAt: "asc" }] },
      domainLinks: {
        include: { domain: true },
        orderBy: { createdAt: "asc" },
      },
      notificationSettings: { orderBy: { createdAt: "asc" } },
      _count: { select: { submissions: true } },
    },
  })
  await logAudit({
    userId,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.FORM,
    resourceId: form.id,
    detail: {
      name: updated.name,
    },
  })
  return updated
}

export async function deleteFormForUser(userId: string, formId: string) {
  const form = await getOwnedFormOrThrow(userId, formId)
  await db.form.delete({ where: { id: form.id } })
  await logAudit({
    userId,
    action: AuditAction.DELETE,
    resourceType: AuditResource.FORM,
    resourceId: form.id,
    detail: {
      name: form.name,
      submissions: form._count.submissions,
    },
  })
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

export async function addFieldToForm(
  userId: string,
  formId: string,
  input: CreateFieldInput
) {
  const form = await getOwnedFormOrThrow(userId, formId)
  const existing = await db.formField.findUnique({
    where: { formId_name: { formId: form.id, name: input.name } },
  })
  if (existing) {
    throw new ApiError(
      `A field with the key "${input.name}" already exists on this form.`,
      409
    )
  }
  const order =
    input.order ??
    (form.fields.length > 0
      ? Math.max(...form.fields.map((f) => f.order)) + 1
      : 0)
  const field = await db.formField.create({
    data: {
      formId: form.id,
      name: input.name,
      label: input.label,
      type: input.type,
      required: input.required ?? false,
      placeholder: input.placeholder,
      options: input.options ?? undefined,
      minLength: input.minLength,
      maxLength: input.maxLength,
      order,
    },
  })
  await logAudit({
    userId,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.FORM,
    resourceId: form.id,
    detail: {
      event: "field-added",
      field: input.name,
    },
  })
  return field
}

export async function updateFieldForUser(
  userId: string,
  formId: string,
  fieldId: string,
  input: UpdateFieldInput
) {
  const form = await getOwnedFormOrThrow(userId, formId)
  const field = form.fields.find((f) => f.id === fieldId)
  if (!field) throw new ApiError("Field not found", 404)
  // A type change to a non-option type drops stale options; a change to
  // an option type without options is rejected by the validator.
  const nextType = input.type ?? field.type
  const isOptionType = ["SELECT", "CHECKBOX", "RADIO"].includes(nextType)
  const updated = await db.formField.update({
    where: { id: field.id },
    data: {
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.required !== undefined ? { required: input.required } : {}),
      ...(input.placeholder !== undefined
        ? { placeholder: input.placeholder }
        : {}),
      // Explicit options replace; omitted options stay, except a move to a
      // non-option type clears them. (Prisma wants DbNull, not plain null,
      // to clear a nullable Json column.)
      ...(input.options !== undefined
        ? { options: input.options ?? Prisma.DbNull }
        : !isOptionType
          ? { options: Prisma.DbNull }
          : {}),
      ...(input.minLength !== undefined ? { minLength: input.minLength } : {}),
      ...(input.maxLength !== undefined ? { maxLength: input.maxLength } : {}),
      ...(input.order !== undefined ? { order: input.order } : {}),
    },
  })
  await logAudit({
    userId,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.FORM,
    resourceId: form.id,
    detail: {
      event: "field-updated",
      field: field.name,
    },
  })
  return updated
}

export async function deleteFieldForUser(
  userId: string,
  formId: string,
  fieldId: string
) {
  const form = await getOwnedFormOrThrow(userId, formId)
  const field = form.fields.find((f) => f.id === fieldId)
  if (!field) throw new ApiError("Field not found", 404)
  await db.formField.delete({ where: { id: field.id } })
  await logAudit({
    userId,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.FORM,
    resourceId: form.id,
    detail: {
      event: "field-deleted",
      field: field.name,
    },
  })
}

// ---------------------------------------------------------------------------
// Domain links (many-to-many)
// ---------------------------------------------------------------------------

export async function linkDomainToForm(
  userId: string,
  formId: string,
  input: LinkDomainInput
) {
  const form = await getOwnedFormOrThrow(userId, formId)
  const domain = await db.domain.findFirst({
    where: { id: input.domainId, ownerId: userId },
  })
  if (!domain) throw new ApiError("Domain not found", 404)
  if (domain.status !== DomainStatus.VERIFIED) {
    throw new ApiError(
      `Only verified domains can be linked. ${domain.domain} is ${domain.status.toLowerCase()}.`,
      409
    )
  }
  const existing = await db.formDomain.findUnique({
    where: { formId_domainId: { formId: form.id, domainId: domain.id } },
  })
  if (existing) {
    throw new ApiError(`${domain.domain} is already linked to this form.`, 409)
  }
  const link = await db.formDomain.create({
    data: { formId: form.id, domainId: domain.id },
    include: { domain: true },
  })
  await logAudit({
    userId,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.FORM,
    resourceId: form.id,
    detail: {
      event: "domain-linked",
      domain: domain.domain,
    },
  })
  return link
}

export async function unlinkDomainFromForm(
  userId: string,
  formId: string,
  domainId: string
) {
  const form = await getOwnedFormOrThrow(userId, formId)
  const link = await db.formDomain.findUnique({
    where: { formId_domainId: { formId: form.id, domainId } },
  })
  if (!link) throw new ApiError("This domain is not linked to the form.", 404)
  await db.formDomain.delete({ where: { id: link.id } })
  await logAudit({
    userId,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.FORM,
    resourceId: form.id,
    detail: {
      event: "domain-unlinked",
      domainId,
    },
  })
}

// ---------------------------------------------------------------------------
// Notification recipients
// ---------------------------------------------------------------------------

export async function addNotificationEmailToForm(
  userId: string,
  formId: string,
  input: AddNotificationEmailInput
) {
  const form = await getOwnedFormOrThrow(userId, formId)
  const email = input.email.trim().toLowerCase()
  const existing = await db.notificationSettings.findUnique({
    where: { formId_email: { formId: form.id, email } },
  })
  if (existing) {
    throw new ApiError(
      `${email} is already a notification recipient for this form.`,
      409
    )
  }
  const created = await db.notificationSettings.create({
    data: { formId: form.id, email },
  })
  await logAudit({
    userId,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.FORM,
    resourceId: form.id,
    detail: {
      event: "notification-added",
      email,
    },
  })
  return created
}

export async function updateNotificationEmailForUser(
  userId: string,
  formId: string,
  notificationId: string,
  input: UpdateNotificationEmailInput
) {
  const form = await getOwnedFormOrThrow(userId, formId)
  const row = form.notificationSettings.find((n) => n.id === notificationId)
  if (!row) throw new ApiError("Notification recipient not found", 404)
  return db.notificationSettings.update({
    where: { id: row.id },
    data: { enabled: input.enabled },
  })
}

export async function deleteNotificationEmailForUser(
  userId: string,
  formId: string,
  notificationId: string
) {
  const form = await getOwnedFormOrThrow(userId, formId)
  const row = form.notificationSettings.find((n) => n.id === notificationId)
  if (!row) throw new ApiError("Notification recipient not found", 404)
  await db.notificationSettings.delete({ where: { id: row.id } })
  await logAudit({
    userId,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.FORM,
    resourceId: form.id,
    detail: {
      event: "notification-removed",
      email: row.email,
    },
  })
}

// ---------------------------------------------------------------------------
// AI-assisted form building (Phase 12, Step 4)
// ---------------------------------------------------------------------------
// Dashboard-initiated: the owner describes the form, the model suggests
// fields, the owner reviews them before any field is created. This
// function only returns suggestions — it never creates a field.

/** Suggests fields for a form from a plain-language description.
    The owner reviews the suggestions in the dashboard and picks which
    to add. Throws 403 when AI is off for the form, 503 when no
    provider is configured. */
export async function suggestFieldsForForm(
  userId: string,
  formId: string,
  prompt: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<FieldSuggestions> {
  const form = await getOwnedFormOrThrow(userId, formId)
  if (!form.aiEnabled) {
    throw new ApiError(
      "AI is not enabled for this form. Enable it in the form settings first.",
      403
    )
  }
  if (!isAiConfigured(env)) {
    throw new ApiError(
      "No AI provider is configured. Set a provider key first.",
      503
    )
  }
  return suggestFields({
    model: getAiModel(env),
    prompt,
    existingFields: form.fields.map((f) => ({
      name: f.name,
      label: f.label,
      type: f.type,
    })),
  })
}
