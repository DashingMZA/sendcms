import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import {
  createFormForUser,
  deleteFormForUser,
  getFormForUser,
  listFormsForUser,
  updateFormForUser,
} from "@sendcms/forms"
import { CreateFormSchema, UpdateFormSchema } from "@sendcms/forms/validators"
import type { McpAuthContext } from "../auth"
import { runTool } from "./shared"

// Form tools (ADR 0009). Read-only tools register for every key;
// mutations only for FULL-scope keys.
export function registerFormTools(server: McpServer, auth: McpAuthContext) {
  server.registerTool(
    "list_forms",
    {
      title: "List forms",
      description:
        "List your contact forms, newest first, with their fields and linked domains.",
      inputSchema: {},
    },
    () => runTool(() => listFormsForUser(auth.userId))
  )

  server.registerTool(
    "get_form",
    {
      title: "Get a form",
      description:
        "Get one form by id, with its fields, linked domains and notification settings.",
      inputSchema: {
        formId: z.string().min(1, "Enter a form id"),
      },
    },
    ({ formId }) => runTool(() => getFormForUser(auth.userId, formId))
  )

  if (auth.scope !== "FULL") return

  server.registerTool(
    "create_form",
    {
      title: "Create a form",
      description:
        "Create a contact form. The form starts with the three default fields (name, email, message) — add more fields from the dashboard.",
      inputSchema: CreateFormSchema.shape,
    },
    (input) => runTool(() => createFormForUser(auth.userId, input))
  )

  server.registerTool(
    "update_form",
    {
      title: "Update a form",
      description:
        "Update a form's name, description, success message, redirect URL, spam protections, or daily limit. Only the fields you pass change.",
      inputSchema: {
        formId: z.string().min(1, "Enter a form id"),
        ...UpdateFormSchema.shape,
      },
    },
    ({ formId, ...input }) =>
      runTool(() => updateFormForUser(auth.userId, formId, input))
  )

  server.registerTool(
    "delete_form",
    {
      title: "Delete a form",
      description:
        "Delete a form and all its submissions. This cannot be undone.",
      inputSchema: {
        formId: z.string().min(1, "Enter a form id"),
      },
    },
    ({ formId }) =>
      runTool(async () => {
        await deleteFormForUser(auth.userId, formId)
        return { deleted: true, formId }
      })
  )
}
