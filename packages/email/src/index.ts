// Platform email — one send path for every platform email: auth mail
// (verification/reset) and submission notifications. Provider priority:
//   1. Resend (RESEND_API_KEY) — plain fetch POST, no new dependency.
//   2. Platform SMTP (SMTP_HOST/SMTP_USER/SMTP_PASS).
//   3. None — callers fail loudly (production) or log (dev).
// Moved here from the app's lib/email/ in Phase 7 (the auth split needs
// it as a package both apps can import). Phase 9: the notifications
// module and the auth factory import the mailer + notification deps
// from here directly — no injection left.
export {
  resolveEmailProvider,
  sendPlatformEmail,
  type EmailProvider,
  type SendEmailInput,
  type SendEmailResult,
} from "./provider"
export { sendPasswordResetEmail, sendVerificationEmail } from "./auth-mailer"
export { notificationDeps } from "./notification-deps"
export type {
  DigestItem,
  DigestProps,
  DigestRenderer,
  NotificationDeps,
  NotificationEmailSender,
  NotificationRenderer,
  SubmissionNotificationField,
  SubmissionNotificationProps,
} from "./notification-types"
// Test-support surface: the transport builders the mailer tests use to
// construct a real SMTP transport the same way the app does.
export { formatFromAddress } from "./transport"
export {
  buildPlatformTransporter,
  getPlatformFromAddress,
} from "./platform-transport"
export {
  SubmissionNotification,
  submissionNotificationText,
} from "./templates/submission-notification"
export { Digest, digestText } from "./templates/digest"
