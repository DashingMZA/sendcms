# Database Schema Conventions

**ORM:** Prisma · **DB:** PostgreSQL · **Schema:** `prisma/schema.prisma` · **Client:** `generated/prisma`

## Rules

| Rule                  | Pattern                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------- |
| Primary key           | `@id @default(cuid())` — never autoincrement                                                 |
| Timestamps            | `createdAt DateTime @default(now())` + `updatedAt DateTime @updatedAt` on every domain model |
| Soft delete           | Status enums (`DELETED`). Never physically delete rows.                                      |
| JSON columns          | `Json` type. Never `String` with JSON.                                                       |
| Enums                 | Use for status/role/action fields. Never `String`.                                           |
| Indexes               | Every FK, every status+timestamp filter, every WHERE field                                   |
| Composite index order | Column order must match query WHERE/ORDER BY                                                 |
| Unique                | `@unique` on natural identifiers (`email`, `domain`)                                          |
| Cascade               | `onDelete: Cascade` for clearly child rows only                                              |

## Naming

| Element            | Convention                | Example                    |
| ------------------ | ------------------------- | -------------------------- |
| Models             | PascalCase                | `Submission`, `SubmissionEvent` |
| Fields             | camelCase                 | `authorName`, `createdAt`  |
| Relations (1:N)    | plural                    | `submissions`, `events`    |
| Relations (N:1)    | singular                  | `form`, `domain`           |
| Enum values        | UPPER_SNAKE_CASE          | `PENDING`, `APPROVED`      |
| Self-ref relations | explicit `@relation` name | none in the current schema |

## Normalization

Apply when creating a new model, or when adding/changing fields on an existing one.

### Always Normalize

- **Entity references** — store a foreign key to another model; never copy its fields onto this row. Duplicated data drifts out of sync.
- **Repeated or shared values** — anything reused across rows (settings, categories, statuses) belongs in its own model or an `enum`, not inline strings.
- **Distinct sub-concerns** — a cohesive cluster of fields serving one responsibility should be its own model once it grows (see "Extract when bloated").

### Denormalize Only With Justification

- Acceptable when the referenced entity genuinely has no row to point to (e.g. capturing data from an unauthenticated/guest actor with no parent record).
- Acceptable for counters or caches kept for performance — only when explicitly needed, and treat them as derived data that can be rebuilt.
- Add a comment stating _why_ the trade-off is justified, so the next reader doesn't "fix" it.

### Extract When Bloated

When a sub-concern accumulates more than ~5–6 fields, move it to a dedicated model linked 1:1 (a `@unique` FK back-reference). This keeps the parent lean and lets the sub-concern be queried independently. The same applies when editing an existing model: if a change pushes a field cluster past that threshold, extract rather than pile on.

```prisma
// Parent stays lean; the sub-concern owns its own fields.
model Parent {
  id     String  @id @default(cuid())
  name   String
  detail Detail? // optional 1:1
}

model Detail {
  id       String @id @default(cuid())
  parentId String @unique
  parent   Parent @relation(fields: [parentId], references: [id], onDelete: Cascade)
  // ...sub-concern fields...
}
```

> In this codebase, `DomainVerification` is the live instance of this pattern (challenge, attempts and expiry live on the verification row, not on `Domain`).

## Migration Workflow

```
Edit schema → prisma validate → pnpm db:migrate --name <name> → review SQL → pnpm db:generate
```

Never edit applied migrations. Create a new one.

## Existing Enums

| Enum            | Values                                 | Used By                              |
| --------------- | -------------------------------------- | ------------------------------------ |
| `PlatformRole`  | PLATFORM_OWNER, PLATFORM_USER          | `User.platformRole`                  |
| `DomainStatus`  | PENDING, VERIFIED, SUSPENDED           | `Domain.status`                      |
| `DomainVerificationMethod` | DNS_TXT, META_TAG, FILE       | `DomainVerification.method`          |
| `DomainVerificationStatus` | PENDING, VERIFIED, FAILED, EXPIRED | `DomainVerification.status`     |
| `FormFieldType` | TEXT, EMAIL, TEXTAREA, NUMBER, SELECT, CHECKBOX, RADIO, URL, TEL, DATE | `FormField.type` |
| `SubmissionStatus` | NEW, READ, STARRED, ARCHIVED, SPAM | `Submission.status`                  |
| `SubmissionEventType` | CREATED, READ, UNREAD, STARRED, UNSTARRED, ARCHIVED, RESTORED, MARKED_SPAM, EMAIL_SENT, EMAIL_FAILED | `SubmissionEvent.type` |
| `EmailJobType`  | SUBMISSION_NOTIFICATION, EMAIL_VERIFICATION, PASSWORD_RESET | `EmailJob.type` |
| `EmailJobStatus` | PENDING, SENDING, SENT, FAILED        | `EmailJob.status`                    |
| `AuditAction`   | CREATE, UPDATE, DELETE, VERIFY, SUSPEND, REACTIVATE | `AuditLog.action`          |
| `AuditResource` | DOMAIN, FORM, SUBMISSION, USER, SETTINGS | `AuditLog.resourceType`           |

## Existing Models

| Model             | Relations                                                                                  | Indexes                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `User`            | has many Account, Session, Domain, Form, SubmissionEvent (as actor), AuditLog (as actor) | `email @unique`                      |
| `Domain`          | → User; has many DomainVerification, FormDomain                                            | `domain @unique`, `@@index([ownerId])`, `@@index([status, createdAt])`                                                  |
| `DomainVerification` | → Domain                                                                              | `@@index([domainId])`, `@@index([domainId, status, createdAt])`                                                         |
| `Form`            | → User; has many FormField, FormDomain, Submission, NotificationSettings, EmailJob          | `@@index([ownerId])`, `@@index([ownerId, active])`                                                                      |
| `FormDomain`      | → Form + Domain (many-to-many join)                                                        | `@@unique([formId, domainId])`, `@@index([formId])`, `@@index([domainId])`                                              |
| `FormField`       | → Form                                                                                     | `@@unique([formId, name])`, `@@index([formId, order])`                                                                  |
| `Submission`      | → Form; has many SubmissionEvent, EmailJob                                                 | `@@unique([formId, idempotencyKey])`, `@@index([formId, status, createdAt])`, `@@index([formId, contentHash, createdAt])` |
| `SubmissionEvent` | → Submission; → User? (actor, SetNull)                                                     | `@@index([submissionId, createdAt])`, `@@index([submissionId, type, createdAt])`                                        |
| `NotificationSettings` | → Form                                                                          | `@@unique([formId, email])`, `@@index([formId])`                                                                        |
| `EmailJob`        | → Form? + Submission? (SetNull)                                                            | `@@index([status, nextAttemptAt, createdAt])`, `@@index([type, createdAt])`                                             |
| `AuditLog`        | → User? (actor, SetNull)                                                                   | `@@index([userId, createdAt])`, `@@index([resourceType, resourceId, createdAt])`                                        |

## Anti-Patterns

- Auto-increment IDs → use CUID
- `String` for JSON → use `Json`
- App-level uniqueness → use `@unique`
- No index on FK → always `@@index([fk])`
- Missing `onDelete` → set explicitly
