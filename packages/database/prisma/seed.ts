// SendCMS demo seed — seeds ONLY SendCMS data (demo user, verified domain,
// form with default fields, sample submissions). The comment system was
// removed entirely, so no legacy models exist to seed.
// Safe to re-run: existing rows are upserted, submissions are created only
// when the demo form has none yet. Demo data only — never run against a
// production database.
import {
  PrismaClient,
  DomainVerificationMethod,
  DomainVerificationStatus,
  DomainStatus,
  FormFieldType,
  SubmissionStatus,
  SubmissionEventType,
} from "../generated/prisma/client"
import { PrismaPg } from "@prisma/adapter-pg"
import { config } from "dotenv"
import { createHash } from "node:crypto"

config()

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
const db = new PrismaClient({ adapter })

const DEMO_USER_EMAIL = "demo@example.com"
const DEMO_DOMAIN = "demo.example.com"
const DEMO_FORM_ID = "demo-form-001"

function contentHash(formId: string, data: Record<string, unknown>): string {
  const sorted = Object.fromEntries(
    Object.entries(data).sort(([a], [b]) => a.localeCompare(b))
  )
  return createHash("sha256")
    .update(formId + JSON.stringify(sorted))
    .digest("hex")
}

async function main() {
  // Demo user — emailVerified so the demo account can register domains.
  // No password / OAuth account is created: this is demo DATA, not a login.
  const user = await db.user.upsert({
    where: { email: DEMO_USER_EMAIL },
    update: { emailVerified: true },
    create: {
      email: DEMO_USER_EMAIL,
      name: "Demo Owner",
      emailVerified: true,
      image: "https://avatars.githubusercontent.com/u/1?v=4",
    },
  })

  // Demo domain, already verified.
  const domain = await db.domain.upsert({
    where: { domain: DEMO_DOMAIN },
    update: { status: DomainStatus.VERIFIED, verifiedAt: new Date() },
    create: {
      name: "Demo Blog",
      domain: DEMO_DOMAIN,
      status: DomainStatus.VERIFIED,
      verifiedAt: new Date(),
      ownerId: user.id,
    },
  })

  // The verification record that got it there (DNS TXT method).
  const existingVerification = await db.domainVerification.findFirst({
    where: { domainId: domain.id, method: DomainVerificationMethod.DNS_TXT },
  })
  if (!existingVerification) {
    await db.domainVerification.create({
      data: {
        method: DomainVerificationMethod.DNS_TXT,
        challenge: "demo-challenge-do-not-use-in-production-00000000",
        status: DomainVerificationStatus.VERIFIED,
        verifiedAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        domainId: domain.id,
      },
    })
  }

  // Demo form (fixed id so re-runs upsert instead of duplicating).
  const form = await db.form.upsert({
    where: { id: DEMO_FORM_ID },
    update: {},
    create: {
      id: DEMO_FORM_ID,
      name: "Contact us",
      description: "Demo contact form",
      active: true,
      successMessage: "Thanks — we'll get back to you soon.",
      honeypotEnabled: true,
      ownerId: user.id,
    },
  })

  // Default fields: name, email, message.
  const defaultFields = [
    {
      name: "name",
      label: "Name",
      type: FormFieldType.TEXT,
      required: true,
      placeholder: "Your name",
      order: 0,
    },
    {
      name: "email",
      label: "Email",
      type: FormFieldType.EMAIL,
      required: true,
      placeholder: "you@example.com",
      order: 1,
    },
    {
      name: "message",
      label: "Message",
      type: FormFieldType.TEXTAREA,
      required: true,
      placeholder: "Your message",
      order: 2,
    },
  ]
  for (const f of defaultFields) {
    await db.formField.upsert({
      where: { formId_name: { formId: form.id, name: f.name } },
      update: {},
      create: { ...f, formId: form.id },
    })
  }

  // Link the verified domain to the form.
  await db.formDomain.upsert({
    where: { formId_domainId: { formId: form.id, domainId: domain.id } },
    update: {},
    create: { formId: form.id, domainId: domain.id },
  })

  // Notification recipient for the demo form.
  await db.notificationSettings.upsert({
    where: { formId_email: { formId: form.id, email: DEMO_USER_EMAIL } },
    update: { enabled: true },
    create: { formId: form.id, email: DEMO_USER_EMAIL, enabled: true },
  })

  // Sample submissions — created only when the form has none yet.
  const existingCount = await db.submission.count({
    where: { formId: form.id },
  })
  if (existingCount === 0) {
    const samples: {
      data: Record<string, string>
      status: SubmissionStatus
    }[] = [
      {
        data: {
          name: "Sara",
          email: "sara@example.com",
          message: "Hi! I love the blog — do you take guest posts?",
        },
        status: SubmissionStatus.NEW,
      },
      {
        data: {
          name: "Bilal",
          email: "bilal@example.com",
          message:
            "The contact form works great. One suggestion: a phone field would help.",
        },
        status: SubmissionStatus.NEW,
      },
      {
        data: {
          name: "Spammy",
          email: "spam@evil.example",
          message:
            "Buy cheap software at https://a.example https://b.example https://c.example https://d.example",
        },
        status: SubmissionStatus.SPAM,
      },
    ]
    for (const s of samples) {
      const submission = await db.submission.create({
        data: {
          data: s.data,
          status: s.status,
          originDomain: DEMO_DOMAIN,
          pageUrl: `https://${DEMO_DOMAIN}/contact`,
          contentHash: contentHash(form.id, s.data),
          formId: form.id,
        },
      })
      await db.submissionEvent.create({
        data: {
          type: SubmissionEventType.CREATED,
          detail:
            s.status === SubmissionStatus.SPAM
              ? { spamReasons: ["too many links"] }
              : { origin: DEMO_DOMAIN },
          submissionId: submission.id,
        },
      })
    }
  }

  const counts = {
    submissions: await db.submission.count({ where: { formId: form.id } }),
  }
  console.log(
    `Seed complete: user ${user.email}, domain ${domain.domain} (VERIFIED), ` +
      `form ${form.id} ("${form.name}"), ${counts.submissions} submissions`
  )
}

main()
  .catch(console.error)
  .finally(() => db.$disconnect())
