import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import {
  createDomainForUser,
  deleteDomainForUser,
  getDomainForUser,
  listDomainsForUser,
  startVerificationForUser,
  verifyDomainForUser,
} from "@sendcms/domains"
import {
  CreateDomainSchema,
  ReverifyDomainSchema,
} from "@sendcms/domains/validators"
import type { McpAuthContext } from "../auth"
import { isToolAllowed, runTool } from "./shared"

// Domain tools (ADR 0009). Read-only tools register for every key;
// mutations only for FULL-scope keys — a read-only key's client never
// sees them in tools/list, so it cannot call what it may not do.
// Every registration is also gated on the admin-set per-user allowlist
// (Phase 6): a tool the allowlist excludes is never registered, so it
// never appears in tools/list either.
export function registerDomainTools(server: McpServer, auth: McpAuthContext) {
  if (isToolAllowed(auth, "list_domains")) {
    server.registerTool(
      "list_domains",
      {
        title: "List domains",
        description:
          "List the domains you registered in SendCMS, newest first, with their verification status and linked-form count.",
        inputSchema: {},
      },
      () => runTool(() => listDomainsForUser(auth.userId))
    )
  }

  if (isToolAllowed(auth, "get_domain")) {
    server.registerTool(
      "get_domain",
      {
        title: "Get a domain",
        description:
          "Get one domain by id, with its verification attempts and linked-form count.",
        inputSchema: {
          domainId: z.string().min(1, "Enter a domain id"),
        },
      },
      ({ domainId }) => runTool(() => getDomainForUser(auth.userId, domainId))
    )
  }

  if (auth.scope !== "FULL") return

  if (isToolAllowed(auth, "create_domain")) {
    server.registerTool(
      "create_domain",
      {
        title: "Create a domain",
        description:
          "Register a domain in SendCMS. A verification challenge is created with it — verify ownership next with verify_domain. Requires a verified account email.",
        inputSchema: CreateDomainSchema.shape,
      },
      (input) => runTool(() => createDomainForUser(auth.userId, input))
    )
  }

  if (isToolAllowed(auth, "verify_domain")) {
    server.registerTool(
      "verify_domain",
      {
        title: "Verify a domain",
        description:
          "Start (or reuse) a verification for a domain, then check ownership right away — DNS TXT record, meta tag, or verification file. Returns whether the domain is now verified and how many attempts remain.",
        inputSchema: {
          domainId: z.string().min(1, "Enter a domain id"),
          ...ReverifyDomainSchema.shape,
        },
      },
      async ({ domainId, ...input }) =>
        runTool(async () => {
          // An already-verified domain answers verified immediately —
          // starting a verification for it would 409. Otherwise start
          // (or reuse / re-method) the pending verification, then check.
          const domain = await getDomainForUser(auth.userId, domainId)
          if (domain.status !== "VERIFIED") {
            await startVerificationForUser(auth.userId, domainId, input)
          }
          return verifyDomainForUser(auth.userId, domainId)
        })
    )
  }

  if (isToolAllowed(auth, "delete_domain")) {
    server.registerTool(
      "delete_domain",
      {
        title: "Delete a domain",
        description:
          "Delete a domain. Refused while any form is still linked to it — unlink those forms first. Pass the domain string as confirmation.",
        inputSchema: {
          domainId: z.string().min(1, "Enter a domain id"),
          confirmation: z
            .string()
            .min(1, "Enter the domain string to confirm deletion"),
        },
      },
      ({ domainId, confirmation }) =>
        runTool(async () => {
          await deleteDomainForUser(auth.userId, domainId, confirmation)
          return { deleted: true, domainId }
        })
    )
  }
}
