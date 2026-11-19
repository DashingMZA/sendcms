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
}
