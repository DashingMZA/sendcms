import { render } from "@react-email/render"
import { sendPlatformEmail } from "./provider"
import type { NotificationDeps } from "./notification-types"
import {
  SubmissionNotification,
  submissionNotificationText,
} from "./templates/submission-notification"
import { Digest, digestText } from "./templates/digest"

/**
 * The platform notification dependencies, used by the notifications
 * module (Phase 9 — the module imports them directly instead of taking
 * them as injected params). The module must not import app code, and
 * this package owns the transport + templates, so the wiring lives here.
 */
async function renderSubmissionNotification(
  props: Parameters<NotificationDeps["renderNotification"]>[0]
): Promise<{ html: string; text: string }> {
  return {
    html: await render(SubmissionNotification(props)),
    text: submissionNotificationText(props),
  }
}

async function renderDigest(
  props: Parameters<NotificationDeps["renderDigest"]>[0]
): Promise<{ html: string; text: string }> {
  return {
    html: await render(Digest(props)),
    text: digestText(props),
  }
}

export const notificationDeps: NotificationDeps = {
  sendEmail: sendPlatformEmail,
  renderNotification: renderSubmissionNotification,
  renderDigest,
}
