import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import {
  bulkUpdateSubmissionsForUser,
  deleteSubmissionForUser,
  getSubmissionForUser,
  listSubmissionsForUser,
  updateSubmissionStatusForUser,
} from "@sendcms/inbox"
import {
  BulkUpdateSubmissionsSchema,
  InboxListQuerySchema,
  UpdateSubmissionStatusSchema,
} from "@sendcms/inbox/validators"
import type { McpAuthContext } from "../auth"
import { runTool } from "./shared"

// Inbox tools (ADR 0009). Read-only tools register for every key;
// mutations only for FULL-scope keys.
export function registerInboxTools(server: McpServer, auth: McpAuthContext) {
  server.registerTool(
    "list_submissions",
    {
      title: "List submissions",
      description:
        "List inbox submissions (newest first) with filters: tab (all, unread, read, starred, archived, spam), form, origin domain, text search, and a date range. Paginated, 20 per page.",
      inputSchema: InboxListQuerySchema.shape,
    },
    (input) => runTool(() => listSubmissionsForUser(auth.userId, input))
  )

  server.registerTool(
    "get_submission",
    {
      title: "Get a submission",
      description:
        "Get one submission by id, with its field values, status, origin, and event history.",
      inputSchema: {
        submissionId: z.string().min(1, "Enter a submission id"),
      },
    },
    ({ submissionId }) =>
      runTool(() => getSubmissionForUser(auth.userId, submissionId))
  )

  if (auth.scope !== "FULL") return

  server.registerTool(
    "update_submission",
    {
      title: "Update a submission",
      description:
        "Change a submission's status: read, unread, star, unstar, archive, restore, spam, or not-spam. Archived and spam submissions must be restored before any other action.",
      inputSchema: {
        submissionId: z.string().min(1, "Enter a submission id"),
        ...UpdateSubmissionStatusSchema.shape,
      },
    },
    ({ submissionId, action }) =>
      runTool(() =>
        updateSubmissionStatusForUser(auth.userId, submissionId, action)
      )
  )

  server.registerTool(
    "bulk_update_submissions",
    {
      title: "Bulk update submissions",
      description: "Apply one status action to up to 100 submissions at once.",
      inputSchema: BulkUpdateSubmissionsSchema.shape,
    },
    ({ ids, action }) =>
      runTool(() => bulkUpdateSubmissionsForUser(auth.userId, ids, action))
  )

  server.registerTool(
    "delete_submission",
    {
      title: "Delete a submission",
      description: "Permanently delete a submission. This cannot be undone.",
      inputSchema: {
        submissionId: z.string().min(1, "Enter a submission id"),
      },
    },
    ({ submissionId }) =>
      runTool(async () => {
        await deleteSubmissionForUser(auth.userId, submissionId)
        return { deleted: true, submissionId }
      })
  )
}
