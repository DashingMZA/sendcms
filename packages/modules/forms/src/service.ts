import { randomBytes } from "node:crypto"
import {
  AuditAction,
  AuditResource,
  DomainStatus,
  FormFieldType,
  Prisma,
  db,
  type NotificationSettings,
} from "@sendcms/database"

import { ApiError } from "@sendcms/shared"

import { redactAuthEmailUrl, sendPlatformEmail } from "@sendcms/email"
import { logAudit } from "@sendcms/security"
import {
  suggestFields,
  type AiCallUsage,
  type AiEnvConfig,
  type AiProviderName,
  type FieldSuggestions,
} from "@sendcms/ai"
import { recordAiUsage, resolveAiModelForUser } from "@sendcms/ai-settings"
import { checkLimitStrict } from "@sendcms/plans"
import { isTurnstileConfigured } from "@sendcms/submissions/turnstile"

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
    // Archived (soft-deleted) forms are invisible: they accept no
    // submissions and cannot be edited, linked, or deleted again.
    where: { id: formId, ownerId: userId, deletedAt: null },
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

// SEC-210: a relative redirect is same-site and always allowed; an
// absolute redirect must land on one of `allowedHosts` (stored domains
// are normalized: lowercase, no leading www.).
export function assertRedirectHostAllowed(
  redirectUrl: string,
  allowedHosts: string[]
): void {
  const value = redirectUrl.trim()
  if (value.startsWith("/")) return
  let host: string
  try {
    host = new URL(value).hostname.toLowerCase().replace(/^www\./, "")
  } catch {
    throw new ApiError("Redirect URL must be a valid http(s) URL.", 400)
  }
  if (!allowedHosts.map((h) => h.toLowerCase()).includes(host)) {
    throw new ApiError(
      "Redirect URL must point to one of this form's verified domains or be a relative URL.",
      400
    )
  }
}

// DSH-105: field `order` values are kept dense and unique (0..n-1) in
// display order. `resequenceFields` takes the fields in their current
// display order (order asc, createdAt asc) and writes back 0..n-1, so
// any insert/move/delete that reorders the list ends duplicate-free.
async function resequenceFields(
  tx: Prisma.TransactionClient,
  fields: { id: string }[]
): Promise<void> {
  for (const [index, field] of fields.entries()) {
    await tx.formField.update({
      where: { id: field.id },
      data: { order: index },
    })
  }
}

export async function getFormCountForUser(userId: string) {
  return db.form.count({ where: { ownerId: userId, deletedAt: null } })
}

export async function listFormsForUser(userId: string) {
  return db.form.findMany({
    where: { ownerId: userId, deletedAt: null },
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

// DSH-107: the paged list — see listDomainsPageForUser for the
// contract. `listFormsForUser` above stays the unpaged call the
// dashboard pages and MCP tools use; the API route takes this one
// so `?search=&page=&perPage=` (or `limit=`) is honoured instead of
// silently dropped. Pagination is clamped here, at the service.
export type FormListQuery = {
  search?: string
  page?: number
  perPage?: number
  sortBy?: "createdAt" | "name"
  sortDir?: "asc" | "desc"
}

export type FormListResult = {
  items: FormWithCounts[]
  total: number
  page: number
  perPage: number
}

export async function listFormsPageForUser(
  userId: string,
  query: FormListQuery = {}
): Promise<FormListResult> {
  const page = Number.isFinite(query.page)
    ? Math.max(1, Math.floor(query.page as number))
    : 1
  const perPage = Number.isFinite(query.perPage)
    ? Math.min(100, Math.max(1, Math.floor(query.perPage as number)))
    : 20
  const where: Prisma.FormWhereInput = { ownerId: userId, deletedAt: null }
  const search = query.search?.trim()
  if (search) {
    where.name = { contains: search, mode: "insensitive" }
  }
  const orderBy =
    query.sortBy === "name"
      ? { name: query.sortDir ?? "asc" }
      : { createdAt: query.sortDir ?? "desc" }
  const [total, items] = await Promise.all([
    db.form.count({ where }),
    db.form.findMany({
      where,
      include: {
        _count: {
          select: { fields: true, domainLinks: true, submissions: true },
        },
      },
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
    }),
  ])
  return { items, total, page, perPage }
}

export async function getFormForUser(userId: string, formId: string) {
  const form = await getOwnedFormOrThrow(userId, formId)
  // EML-004: the dashboard must show which recipients are unconfirmed.
  // A pending confirmation token means "not yet confirmed" — see the
  // recipient-verification section below for the invariant. One return
  // shape (never the raw form) so `confirmed` exists on every row.
  const pendingIds = new Set<string>()
  if (form.notificationSettings.length > 0) {
    const pending = await db.verification.findMany({
      where: {
        identifier: {
          in: form.notificationSettings.map((n) =>
            recipientConfirmIdentifier(n.id)
          ),
        },
      },
      select: { identifier: true },
    })
    for (const row of pending) pendingIds.add(row.identifier)
  }
  return {
    ...form,
    notificationSettings: form.notificationSettings.map((row) => ({
      ...row,
      confirmed: !pendingIds.has(recipientConfirmIdentifier(row.id)),
    })),
  }
}

export type FormDetail = Awaited<ReturnType<typeof getFormForUser>>

/** A notification recipient as the dashboard sees it: the Prisma row
    plus whether its address has been confirmed (EML-004). */
export type NotificationRecipientWithConfirmation = NotificationSettings & {
  confirmed: boolean
}

export async function createFormForUser(
  userId: string,
  input: CreateFormInput
) {
  // SDK-016: a form with Turnstile on and no server secret is bricked
  // — every submit 503s. Refuse to create one in an unconfigured
  // environment instead of building a form that can never accept a
  // submission.
  if (input.turnstileEnabled && !isTurnstileConfigured()) {
    throw new ApiError(
      "Turnstile cannot be enabled: bot protection is not configured on this server.",
      422
    )
  }
  // DB-029: the plan quota check and the create run under a per-user
  // advisory lock, so two concurrent creates cannot both see
  // `used = limit - 1` and both succeed (same pattern as
  // createDomainForUser). The redirect check runs inside the
  // transaction too, so the quota-first error precedence is kept.
  const created = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"sendcms:create:form:" + userId}))`
    // Entitlement guard (Phase 4): the FORMS limit from the user's
    // effective plan. SRC-216: fail CLOSED — a plans-module error
    // refuses the creation (503) instead of silently granting
    // unlimited forms.
    const limit = await checkLimitStrict(userId, "FORMS")
    if (!limit.allowed) {
      throw new ApiError(
        `Your plan allows at most ${limit.limit} forms. Upgrade your plan or ask an admin to raise your limit.`,
        409
      )
    }
    // SEC-210: an absolute redirect may only point at a VERIFIED domain
    // the owner controls (the form has no linked domains yet at creation,
    // so the owner's verified domains are the allowlist). Relative
    // redirects are same-site and need no lookup.
    if (input.redirectUrl && !input.redirectUrl.trim().startsWith("/")) {
      const verified = await db.domain.findMany({
        where: { ownerId: userId, status: DomainStatus.VERIFIED },
        select: { domain: true },
      })
      assertRedirectHostAllowed(
        input.redirectUrl,
        verified.map((d) => d.domain)
      )
    }
    return tx.form.create({
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
  // SDK-016: refuse to NEWLY enable Turnstile while the server secret
  // is unset — the form would be bricked (every submit 503s). A form
  // that already has Turnstile on keeps working (and keeps being
  // editable) — only the false → true transition is refused.
  if (input.turnstileEnabled === true && !form.turnstileEnabled) {
    if (!isTurnstileConfigured()) {
      throw new ApiError(
        "Turnstile cannot be enabled: bot protection is not configured on this server.",
        422
      )
    }
  }
  // SEC-210: an absolute redirect may only point at one of the form's
  // linked (hence VERIFIED) domains.
  if (input.redirectUrl) {
    assertRedirectHostAllowed(
      input.redirectUrl,
      form.domainLinks.map((l) => l.domain.domain)
    )
  }
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

/** Archives a form (Phase 16, SRC-208): the row is soft-deleted
    (`deletedAt`) instead of physically deleted, so its submissions,
    events, notification settings and email jobs survive — deleting a
    form no longer cascade-destroys its submission history. The
    caller must pass the form's name as an explicit confirmation
    token, so a stray click or a replayed request cannot archive a
    form the owner did not name. No step-up here yet: the step-up
    verify route is admin-only, and dashboard users have no way to
    satisfy it — that is a follow-up, not a silent 403. */
export async function deleteFormForUser(
  userId: string,
  formId: string,
  confirmation: string
) {
  const form = await getOwnedFormOrThrow(userId, formId)
  if (confirmation !== form.name) {
    throw new ApiError("Confirmation does not match the form name.", 422)
  }
  await db.form.update({
    where: { id: form.id },
    data: { deletedAt: new Date() },
  })
  await logAudit({
    userId,
    action: AuditAction.DELETE,
    resourceType: AuditResource.FORM,
    resourceId: form.id,
    detail: {
      event: "form-archived",
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
  // An explicit order inserts at that position and shifts the siblings
  // (DSH-105): a verbatim write would duplicate the order value.
  // SRC-206: the pre-check above is not enough — a concurrent
  // duplicate key surfaces as P2002, which is a 409, never a 500.
  let field
  try {
    field =
      input.order === undefined
        ? await db.formField.create({
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
        : await db.$transaction(async (tx) => {
            const created = await tx.formField.create({
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
            const next = [...form.fields]
            next.splice(
              Math.max(0, Math.min(input.order!, form.fields.length)),
              0,
              created
            )
            await resequenceFields(tx, next)
            return created
          })
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ApiError(
        `A field with the key "${input.name}" already exists on this form.`,
        409
      )
    }
    throw err
  }
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
  const data = {
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
  }
  // DSH-105: an order change moves the field to that position and
  // re-sequences the siblings (0..n-1) in the same transaction — a
  // verbatim write would duplicate the order value and the moved field
  // would sort behind the field it was meant to pass.
  const updated =
    input.order === undefined
      ? await db.formField.update({ where: { id: field.id }, data })
      : await db.$transaction(async (tx) => {
          const moved = await tx.formField.update({
            where: { id: field.id },
            data,
          })
          const others = form.fields.filter((f) => f.id !== field.id)
          const target = Math.max(0, Math.min(input.order!, others.length))
          const next = [...others]
          next.splice(target, 0, field)
          await resequenceFields(tx, next)
          // The resequence sets this field's order to its new position.
          return { ...moved, order: target }
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
  // DSH-105: deleting a field re-sequences the survivors so orders stay
  // dense (0..n-1) instead of leaving a gap.
  await db.$transaction(async (tx) => {
    await tx.formField.delete({ where: { id: field.id } })
    await resequenceFields(
      tx,
      form.fields.filter((f) => f.id !== field.id)
    )
  })
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
  // DB-028: the pre-check is not enough — a concurrent duplicate
  // link surfaces as P2002, which is a 409, never a 500.
  let link
  try {
    link = await db.formDomain.create({
      data: { formId: form.id, domainId: domain.id },
      include: { domain: true },
    })
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ApiError(
        `${domain.domain} is already linked to this form.`,
        409
      )
    }
    throw err
  }
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
// Notification recipients — verification (EML-004)
// ---------------------------------------------------------------------------
// A recipient address is only mailed after its owner clicks a confirmation
// link. No schema change was needed for this:
//   - the row stays disabled (`enabled: false`) until confirmed, and the
//     submission notifier already only enqueues for `enabled: true` rows,
//     so an unconfirmed recipient receives no notification jobs;
//   - the one-time token lives in Better Auth's generic `Verification`
//     table (identifier / value / expiresAt), namespaced so it can never
//     collide with auth tokens.
// The token row IS the unconfirmed state: confirming deletes it and
// enables the row, so a row with a pending token is unconfirmed and a
// row without one was confirmed (or was switched off by its owner
// afterwards). The dashboard toggle therefore cannot re-enable an
// unconfirmed recipient — enabling a row with a pending token is
// refused with 409. There is no address-change endpoint (only
// `enabled` can be updated), so changing an address means delete +
// re-add, which issues a fresh token and re-confirms by construction.

const RECIPIENT_CONFIRM_TTL_MS = 24 * 60 * 60 * 1000

function recipientConfirmIdentifier(notificationId: string): string {
  return `notification-confirm:${notificationId}`
}

function recipientConfirmUrl(formId: string, token: string): string {
  const apiUrl =
    process.env.BETTER_AUTH_URL ??
    process.env.NEXT_PUBLIC_API_URL ??
    "http://localhost:3001"
  return `${apiUrl}/api/v1/forms/${formId}/notifications/confirm?token=${token}`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

async function createRecipientConfirmation(
  notificationId: string
): Promise<string> {
  const token = randomBytes(32).toString("base64url")
  await db.verification.create({
    data: {
      identifier: recipientConfirmIdentifier(notificationId),
      value: token,
      expiresAt: new Date(Date.now() + RECIPIENT_CONFIRM_TTL_MS),
    },
  })
  return token
}

// Sends the confirmation link for a recipient. The token is never logged
// in the clear (EML-002): without a provider, dev logs the redacted link
// shape only, with the same explicit opt-in as the auth mailer.
// A production failure is loud (502) — the row stays saved as
// unconfirmed and the owner can resend from the form settings.
async function sendRecipientConfirmation({
  formId,
  formName,
  email,
  token,
}: {
  formId: string
  formName: string
  email: string
  token: string
}): Promise<void> {
  const url = recipientConfirmUrl(formId, token)
  const subject = `Confirm notifications for ${formName}`
  const html =
    `<p>You're receiving this because ${escapeHtml(email)} was added as a notification recipient ` +
    `for the SendCMS form "${escapeHtml(formName)}".</p>` +
    `<p><a href="${escapeHtml(url)}">Confirm this email address</a></p>` +
    `<p>This link expires in 24 hours. If you didn't expect this email, you can safely ignore it.</p>`
  const text =
    `Confirm ${email} as a notification recipient for the SendCMS form "${formName}": ${url}\n\n` +
    `This link expires in 24 hours. If you didn't expect this email, you can safely ignore it.`
  try {
    await sendPlatformEmail({ to: email, subject, html, text })
    return
  } catch {
    if (process.env.NODE_ENV === "production") {
      throw new ApiError(
        "Could not send the confirmation email. The recipient was saved as unconfirmed — resend the confirmation link from the form settings.",
        502
      )
    }
    // Dev fallback, mirroring the auth mailer: log the link shape, never
    // the token (EML-002). Same explicit opt-in prints the full link.
    console.log(
      `[recipient-confirm] No email provider — confirmation link for ${email}: ${
        process.env.SENDCMS_DEV_LOG_EMAIL_TOKENS === "1"
          ? url
          : redactAuthEmailUrl(url)
      }`
    )
  }
}

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
  // Disabled until confirmed (EML-004): no notification job is created
  // for this address until the recipient clicks the confirmation link.
  // DB-028: the pre-check is not enough — a concurrent duplicate
  // recipient surfaces as P2002, which is a 409, never a 500.
  let created
  try {
    created = await db.notificationSettings.create({
      data: { formId: form.id, email, enabled: false },
    })
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new ApiError(
        `${email} is already a notification recipient for this form.`,
        409
      )
    }
    throw err
  }
  const token = await createRecipientConfirmation(created.id)
  await sendRecipientConfirmation({
    formId: form.id,
    formName: form.name,
    email,
    token,
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

/** Confirms a notification recipient from the link in its confirmation
    email. Public — the recipient clicking the link is not signed in, so
    the token is the only credential; it is single-use (deleted on
    confirm) and expires after 24 hours. An expired token is left in
    place so the row keeps reading as unconfirmed until the owner
    resends a fresh link. */
export async function confirmNotificationEmail(
  formId: string,
  token: string
): Promise<{ formId: string; notificationId: string; email: string }> {
  const stored = await db.verification.findFirst({
    where: { value: token },
  })
  if (!stored || !stored.identifier.startsWith("notification-confirm:")) {
    throw new ApiError("This confirmation link is invalid.", 404)
  }
  const notificationId = stored.identifier.slice("notification-confirm:".length)
  if (stored.expiresAt.getTime() < Date.now()) {
    throw new ApiError(
      "This confirmation link has expired. Ask the form owner to resend it.",
      410
    )
  }
  const row = await db.notificationSettings.findUnique({
    where: { id: notificationId },
  })
  if (!row || row.formId !== formId) {
    throw new ApiError("This confirmation link is invalid.", 404)
  }
  const form = await db.form.findUnique({
    where: { id: formId },
    select: { id: true, ownerId: true },
  })
  await db.$transaction([
    db.notificationSettings.update({
      where: { id: row.id },
      data: { enabled: true },
    }),
    db.verification.delete({ where: { id: stored.id } }),
  ])
  if (form) {
    await logAudit({
      userId: form.ownerId,
      action: AuditAction.UPDATE,
      resourceType: AuditResource.FORM,
      resourceId: form.id,
      detail: {
        event: "notification-confirmed",
        email: row.email,
      },
    })
  }
  return { formId: row.formId, notificationId: row.id, email: row.email }
}

/** Re-sends the confirmation email for an unconfirmed recipient
    (expired link, lost email). Deletes the previous token so only the
    newest link works. */
export async function resendNotificationConfirmation(
  userId: string,
  formId: string,
  notificationId: string
) {
  const form = await getOwnedFormOrThrow(userId, formId)
  const row = form.notificationSettings.find((n) => n.id === notificationId)
  if (!row) throw new ApiError("Notification recipient not found", 404)
  if (row.enabled) {
    throw new ApiError(`${row.email} is already confirmed.`, 409)
  }
  await db.verification.deleteMany({
    where: { identifier: recipientConfirmIdentifier(row.id) },
  })
  const token = await createRecipientConfirmation(row.id)
  await sendRecipientConfirmation({
    formId: form.id,
    formName: form.name,
    email: row.email,
    token,
  })
  return row
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
  // EML-004: an unconfirmed recipient (a pending confirmation token
  // exists) cannot be switched on from the dashboard — only the
  // confirmation link enables it. A row with no pending token was
  // confirmed before and only switched off, so re-enabling it is fine.
  if (input.enabled && !row.enabled) {
    const pending = await db.verification.findFirst({
      where: { identifier: recipientConfirmIdentifier(row.id) },
      select: { id: true },
    })
    if (pending) {
      throw new ApiError(
        `${row.email} has not confirmed yet. Resend the confirmation link from the form settings first.`,
        409
      )
    }
  }
  // SRC-236: the update had no audit entry while add/confirm/remove
  // all log one — an enabled-toggle is a notification-affecting
  // change and belongs in the trail too.
  const updated = await db.notificationSettings.update({
    where: { id: row.id },
    data: { enabled: input.enabled },
  })
  await logAudit({
    userId,
    action: AuditAction.UPDATE,
    resourceType: AuditResource.FORM,
    resourceId: form.id,
    detail: {
      event: "notification-updated",
      email: row.email,
      enabled: input.enabled,
    },
  })
  return updated
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
  await db.verification.deleteMany({
    where: { identifier: recipientConfirmIdentifier(row.id) },
  })
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
    provider is configured. The model is resolved for the FORM OWNER
    (BYOK key, browser-only key, or platform key — see
    resolveAiModelForUser); `opts` carries an optional per-request
    browser-only key, which is never stored. `aiEnv` is the explicit
    AI config built from the route (SRC-123) — never the whole
    process.env. */
export async function suggestFieldsForForm(
  userId: string,
  formId: string,
  prompt: string,
  aiEnv: AiEnvConfig,
  opts: {
    provider?: AiProviderName
    browserKey?: string
    browserModel?: string
  } = {}
): Promise<FieldSuggestions> {
  const form = await getOwnedFormOrThrow(userId, formId)
  if (!form.aiEnabled) {
    throw new ApiError(
      "AI is not enabled for this form. Enable it in the form settings first.",
      403
    )
  }
  let resolved
  try {
    resolved = await resolveAiModelForUser(userId, {
      purpose: "suggest-fields",
      resourceId: formId,
      provider: opts.provider,
      browserKey: opts.browserKey,
      browserModel: opts.browserModel,
      env: aiEnv,
    })
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw new ApiError("AI is not available right now. Try again later.", 503)
  }
  const usage: { current: AiCallUsage | null } = { current: null }
  let result
  try {
    result = await suggestFields({
      model: resolved.model,
      prompt,
      existingFields: form.fields.map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
      })),
      onUsage: (u) => {
        usage.current = u
      },
    })
  } catch (err) {
    await recordAiUsage({
      userId,
      provider: resolved.provider,
      model: resolved.modelId,
      billingMode: resolved.billingMode,
      status: "FAILED",
      sourceEvent: "suggest-fields",
      resourceId: formId,
    })
    throw err
  }
  await recordAiUsage({
    userId,
    provider: resolved.provider,
    model: resolved.modelId,
    billingMode: resolved.billingMode,
    status: "SUCCESS",
    tokensIn: usage.current?.promptTokens ?? null,
    tokensOut: usage.current?.completionTokens ?? null,
    sourceEvent: "suggest-fields",
    resourceId: formId,
  })
  return result
}
