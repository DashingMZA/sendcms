import { render } from "@react-email/render"
import type { NotificationDeps } from "@sendcms/notifications"
import { sendPlatformEmail } from "./provider"
import {
  SubmissionNotification,
  submissionNotificationText,
} from "./templates/submission-notification"

/**
 * The app's notification dependencies, passed to the notifications
 * module. The module must not import app code (Phase 9 owns the email
 * transport + templates), so the cron + test-email routes hand these in.
 */
async function renderSubmissionNotification(
  props: Parameters<NotificationDeps["renderNotification"]>[0]
): Promise<{ html: string; text: string }> {
  return {
    html: await render(SubmissionNotification(props)),
    text: submissionNotificationText(props),
  }
}

export const notificationDeps: NotificationDeps = {
  sendEmail: sendPlatformEmail,
  renderNotification: renderSubmissionNotification,
}
