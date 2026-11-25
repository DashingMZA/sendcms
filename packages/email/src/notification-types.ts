// Submission-notification contract (Phase 9). The notifications module
// constructs these props and this package renders + sends them. The
// types live here (with the renderer) so the dependency runs one way:
// notifications → email. The template's Props type is this same shape —
// it imports it now instead of redefining it.
export type SubmissionNotificationField = {
  label: string
  value: string
}

export type SubmissionNotificationProps = {
  formName: string
  senderName: string | null
  senderEmail: string | null
  fields: SubmissionNotificationField[]
  pageUrl: string | null
  originDomain: string
  receivedAt: Date
  inboxUrl: string
  accentColor: string
  footerText: string
  /** Recipient locale ("en" | "ur"). Drives the template chrome
      strings and the received-date formatting; defaults to English. */
  locale?: string
}

export type NotificationEmailSender = (input: {
  to: string
  subject: string
  html: string
  text?: string
}) => Promise<{ messageId: string; provider: string }>

export type NotificationRenderer = (
  props: SubmissionNotificationProps
) => Promise<{ html: string; text: string }>

export type NotificationDeps = {
  sendEmail: NotificationEmailSender
  renderNotification: NotificationRenderer
  renderDigest: DigestRenderer
  renderReply: ReplyRenderer
}

// Digest email (Phase 12, Step 3). The props are the pre-rendered
// digest content — generated at enqueue time by the worker and stored
// on the EmailJob payload, then rendered at send time. `items` is the
// mechanical list of the period's new submissions; `summary` and
// `highlights` are the model's words.
export type DigestItem = {
  senderName: string | null
  snippet: string
  receivedAt: Date
}

export type DigestProps = {
  formName: string
  count: number
  summary: string
  highlights: string[]
  items: DigestItem[]
  inboxUrl: string
  accentColor: string
  footerText: string
  /** Recipient locale ("en" | "ur"). Drives the template chrome
      strings and the item dates; defaults to English. */
  locale?: string
  /** SRC-203 / DB-031: set when the digest hit the 50-submission
      cap — `count` is only the included items, `totalCount` is every
      new submission in the window. The renderers can say "and N
      more" instead of silently dropping the rest. */
  truncated?: boolean
  totalCount?: number
}

export type DigestRenderer = (
  props: DigestProps
) => Promise<{ html: string; text: string }>

// Reply email (Phase 12, Step 4). The props are the owner's reply —
// written by the model as a draft, then reviewed and edited by the
// owner before send. The body is the owner's own words, stored on the
// EmailJob payload at enqueue time.
export type ReplyProps = {
  formName: string
  body: string
  accentColor: string
  footerText: string
  /** Recipient locale ("en" | "ur"). Drives the template chrome
      strings (the body itself is the owner's own words, never
      translated); defaults to English. */
  locale?: string
}

export type ReplyRenderer = (
  props: ReplyProps
) => Promise<{ html: string; text: string }>
