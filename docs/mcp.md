---
description: "SendCMS exposes a Model Context Protocol (MCP) server so an AI host can list domains and forms and read inbox submissions without opening the dashboard."
---

# MCP server

SendCMS exposes a Model Context Protocol (MCP) server so an AI host —
Claude Desktop, an IDE, an agent — can list your domains and forms,
read inbox submissions, and act on them without you opening the
dashboard. It is a second API surface over the same business logic, not
a second product: every tool call goes through the same service
functions the dashboard uses, so a key can never see another owner's
data. Like the [REST API](rest-api.md#stability), the MCP surface is
beta — it may change without a migration path, and there is no
deprecation policy yet.

Base URL: `https://YOUR_APP` (your SendCMS deployment — the api app's
URL; in production `https://api.sendcms.bond`). One endpoint:
`POST /api/mcp`. Transport is Streamable HTTP (stateless, no sessions);
the older HTTP+SSE transport is not offered.

```mermaid
flowchart LR
    Client["MCP client\n(Claude Desktop / IDE / agent)"]
    Endpoint["POST /api/mcp\nStreamable HTTP"]
    Auth["Bearer API key\nSHA-256 hash lookup\n+ scope check"]
    Tools["19 tools\nREAD: 9 · FULL: 19"]
    Services["packages/modules/*\nservices (same as dashboard)"]
    DB[("PostgreSQL")]

    Client --> Endpoint --> Auth --> Tools --> Services --> DB
```

## Contents

- [Create an API key](#create-an-api-key)
- [Connect a client](#connect-a-client)
- [Tools](#tools)
- [Rate limits](#rate-limits)
- [Errors](#errors)
- [Security notes](#security-notes)

## Create an API key

MCP clients cannot use the dashboard's session cookie — there is no
browser and no login flow. They authenticate with a per-user bearer API
key.

1. Dashboard → **API Keys** (`/dashboard/api-keys`).
2. Give the key a name and pick a scope:

   | Scope    | Tools       | Includes                                                                           |
   | -------- | ----------- | ---------------------------------------------------------------------------------- |
   | **FULL** | all 19      | Mutations (create/delete domains and forms, update submissions, send test emails). |
   | **READ** | 9 read-only | List/get/overview only.                                                            |

3. Copy the key when it appears. **It is shown once** — the server
   stores only a SHA-256 hash of it, so a lost key cannot be recovered;
   create a new one instead.

At most 10 active keys per user. A key can be revoked (instantly stops
working) or rotated (old key revoked, new key issued with the same name
and scope) from the same page. Creating, revoking, and rotating keys
are written to the audit log.

## Connect a client

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "sendcms": {
      "url": "https://YOUR_APP/api/mcp",
      "headers": {
        "Authorization": "Bearer sk_live_YOUR_API_KEY"
      }
    }
  }
}
```

Any MCP client that supports remote Streamable HTTP servers works the
same way: endpoint `POST /api/mcp`, header
`Authorization: Bearer <key>`. Clients that only support the deprecated
HTTP+SSE transport or `stdio` cannot connect — SendCMS offers neither.

## Tools

| Tool                      | Scope | What it does                                                                                                                                                                                                  |
| ------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_domains`            | READ  | List the domains you registered in SendCMS, newest first, with their verification status and linked-form count.                                                                                               |
| `get_domain`              | READ  | Get one domain by id, with its verification attempts and linked-form count.                                                                                                                                   |
| `create_domain`           | FULL  | Register a domain in SendCMS. A verification challenge is created with it — verify ownership next with verify_domain. Requires a verified account email.                                                      |
| `verify_domain`           | FULL  | Start (or reuse) a verification for a domain, then check ownership right away — DNS TXT record, meta tag, or verification file. Returns whether the domain is now verified and how many attempts remain.      |
| `delete_domain`           | FULL  | Delete a domain. Refused while any form is still linked to it — unlink those forms first. Pass the domain string as confirmation.                                                                             |
| `list_forms`              | READ  | List your contact forms, newest first, with their fields and linked domains.                                                                                                                                  |
| `get_form`                | READ  | Get one form by id, with its fields, linked domains and notification settings.                                                                                                                                |
| `create_form`             | FULL  | Create a contact form. The form starts with the three default fields (name, email, message) — add more fields from the dashboard. Link a verified domain from the dashboard before it can accept submissions. |
| `update_form`             | FULL  | Update a form's name, description, success message, redirect URL, spam protections, or daily limit. Only the fields you pass change.                                                                          |
| `delete_form`             | FULL  | Archive a form and hide it from the dashboard. Its submissions are kept. Pass the form name as confirmation.                                                                                                  |
| `list_submissions`        | READ  | List inbox submissions (newest first) with filters: tab (all, unread, read, starred, archived, spam), form, origin domain, text search, and a date range. Paginated, 20 per page.                             |
| `get_submission`          | READ  | Get one submission by id, with its field values, status, origin, and event history.                                                                                                                           |
| `update_submission`       | FULL  | Change a submission's status: read, unread, star, unstar, archive, restore, spam, or not-spam. Archived and spam submissions must be restored before any other action.                                        |
| `bulk_update_submissions` | FULL  | Apply one status action to up to 100 submissions at once.                                                                                                                                                     |
| `delete_submission`       | FULL  | Permanently delete a submission. This cannot be undone.                                                                                                                                                       |
| `get_overview`            | READ  | Your account at a glance: domain, form and submission counts, recent submissions, and the unread total.                                                                                                       |
| `get_analytics`           | READ  | Per-day submission counts and the status breakdown for the last N days (default 30, max 365).                                                                                                                 |
| `list_email_jobs`         | READ  | List the email notification outbox (newest first) with filters: delivery status (PENDING, SENT, FAILED), form, and page. Paginated.                                                                           |
| `send_test_email`         | FULL  | Send a test submission-notification email for a form to one address, to check that delivery works.                                                                                                            |

The "What it does" column copies each tool's registered description
verbatim (`packages/mcp/src/tools/*.ts`); a test
(`tests/wave8-stream-d.test.ts`, "docs/mcp.md tools table") asserts
the table matches the live `tools/list` output, so the two cannot
drift apart again.

A READ key calling a FULL tool gets an MCP tool error, not an HTTP
error: HTTP 200 with a JSON-RPC result `{"isError": true,
"content": [{"type": "text", "text": "MCP error -32602: Tool
<name> not found"}]}` — the tool is not even registered for that
key, so it never reaches the service layer. A tool excluded by an
admin-set per-user allowlist is different: that refusal happens
before the server is built and answers HTTP 404 `{"error": "Tool
<name> not found"}`. Disallowed tools are also omitted from
`tools/list` (as are all FULL tools for a READ key).

Explicitly **not** tools: public submit (submissions arrive
unauthenticated through `POST /api/public/v1/submit` with its spam
heuristics, honeypot, and rate limits — MCP must not become a second,
privileged submission path), user management, and cron/worker
internals.

## Rate limits

Per key, the **defaults** are **120 calls/minute** and **2,000
calls/hour** (DB-backed fixed windows) — defaults, not fixed limits.
The effective limit resolves as: admin per-user override → your
plan's entitlements (`mcpRequestsPerMinute` /
`mcpRequestsPerHour`) → these defaults, so a paid plan may allow
more than the numbers above (the constants live in
`packages/mcp/src/rate-limit.ts`: `MCP_MINUTE_LIMIT = 120`,
`MCP_HOUR_LIMIT = 2000`). Over the limit, `tools/call` answers
`429`. `initialize` and `tools/list` are not rate-limited — only
tool calls count.

## Errors

| Status  | Meaning                                                                                |
| ------- | -------------------------------------------------------------------------------------- |
| **401** | Missing, unknown, or revoked API key. Create or rotate a key at `/dashboard/api-keys`. |
| **400** | Malformed JSON body, or a body that is not a JSON object.                              |
| **403** | Suspended account, or MCP disabled for this account by the platform administrator.     |
| **404** | Tool not in the key's admin-set allowlist (`Tool <name> not found`).                   |
| **405** | Anything but POST on `/api/mcp` (GET and DELETE are rejected).                         |
| **413** | Body over 4 MiB.                                                                       |
| **429** | Rate limit for this key (see above).                                                   |
| **503** | MCP temporarily disabled by the platform administrator (global kill-switch).           |

The 403 / 404 / 503 refusals come from the admin MCP controls
(`packages/mcp/src/access.ts`) — see
[admin-control-plane/mcp-management.md](admin-control-plane/mcp-management.md)
for the kill-switch, per-user disable, and allowlist. A READ key
calling a FULL tool is NOT one of these rows: it gets an MCP tool
error over HTTP 200 (see Tools above), because the tool is not
registered for that key at all.

Tool-level errors (unknown id, validation failure) come back as MCP
tool errors (`isError: true`) with a plain message, not as HTTP errors.

## Security notes

- A FULL key is as powerful as your dashboard session for the
  capabilities above. Treat it like a password: never commit it, never
  paste it into a shared chat, and prefer READ keys for read-only
  assistants.
- Keys are scoped to one user and one account — they cannot reach
  another owner's domains, forms, or submissions.
- If a key leaks, revoke it immediately from `/dashboard/api-keys` and
  create a replacement. Revocation takes effect on the next request.

Admin-side MCP controls (kill-switch, per-user settings, usage) live
in the admin control plane — see
[admin-control-plane/mcp-management.md](admin-control-plane/mcp-management.md)
(`feature/admin-control-plane` branch, live in production since
2026-11-23).
