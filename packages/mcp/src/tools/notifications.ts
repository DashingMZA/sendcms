import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import {
  listEmailJobsForUser,
  sendTestSubmissionEmail,
} from "@sendcms/notifications"
import {
  EmailJobListQuerySchema,
  TestEmailSchema,
} from "@sendcms/notifications/validators"
import type { McpAuthContext } from "../auth"
import { isToolAllowed, runTool } from "./shared"

// Notification tools (ADR 0009). list_email_jobs is read-only and
// registers for every key; send_test_email is a mutation (FULL only).
// Every registration is also gated on the admin-set per-user allowlist
// (Phase 6).
export function registerNotificationTools(
  server: McpServer,
  auth: McpAuthContext
) {
  if (isToolAllowed(auth, "list_email_jobs")) {
    server.registerTool(
      "list_email_jobs",
      {
        title: "List email jobs",
        description:
          "List the email notification outbox (newest first) with filters: delivery status (PENDING, SENT, FAILED), form, and page. Paginated.",
        inputSchema: EmailJobListQuerySchema.shape,
      },
      (input) => runTool(() => listEmailJobsForUser(auth.userId, input))
    )
  }

  if (auth.scope !== "FULL") return

  if (isToolAllowed(auth, "send_test_email")) {
    server.registerTool(
      "send_test_email",
      {
        title: "Send a test email",
        description:
          "Send a test submission-notification email for a form to one address, to check that delivery works.",
        inputSchema: {
          formId: z.string().min(1, "Enter a form id"),
          ...TestEmailSchema.shape,
        },
      },
      ({ formId, to }) =>
        runTool(() => sendTestSubmissionEmail(auth.userId, formId, to))
    )
  }
}
