import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import {
  getDashboardOverview,
  getSubmissionAnalytics,
} from "@sendcms/analytics"
import type { McpAuthContext } from "../auth"
import { isToolAllowed, runTool } from "./shared"

// Analytics tools (ADR 0009). Both are read-only, so they register for
// every key regardless of scope. Every registration is also gated on
// the admin-set per-user allowlist (Phase 6).
export function registerAnalyticsTools(
  server: McpServer,
  auth: McpAuthContext
) {
  if (isToolAllowed(auth, "get_overview")) {
    server.registerTool(
      "get_overview",
      {
        title: "Get the dashboard overview",
        description:
          "Your account at a glance: domain, form and submission counts, recent submissions, and the unread total.",
        inputSchema: {},
      },
      () => runTool(() => getDashboardOverview(auth.userId))
    )
  }

  if (isToolAllowed(auth, "get_analytics")) {
    server.registerTool(
      "get_analytics",
      {
        title: "Get submission analytics",
        description:
          "Per-day submission counts and the status breakdown for the last N days (default 30, max 365).",
        inputSchema: {
          days: z
            .number()
            .int()
            .min(1)
            .max(365)
            .optional()
            .describe("Number of days back from today (default 30)"),
        },
      },
      ({ days }) =>
        runTool(() => getSubmissionAnalytics(auth.userId, days ?? 30))
    )
  }
}
