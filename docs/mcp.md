# MCP server

SendCMS exposes a Model Context Protocol (MCP) server so an AI host —
Claude Desktop, an IDE, an agent — can list your domains and forms,
read inbox submissions, and act on them without you opening the
dashboard. It is a second API surface over the same business logic, not
a second product: every tool call goes through the same service
functions the dashboard uses, so a key can never see another owner's
data.

Base URL: `https://YOUR_APP` (your SendCMS deployment — the api app's
URL). One endpoint: `POST /api/mcp`. Transport is Streamable HTTP
(stateless, no sessions); the older HTTP+SSE transport is not offered.

## Create an API key

MCP clients cannot use the dashboard's session cookie — there is no
browser and no login flow. They authenticate with a per-user bearer API
key.

1. Dashboard → **API Keys** (`/dashboard/api-keys`).
2. Give the key a name and pick a scope:
   - **FULL** — all 19 tools, including mutations (create/delete
     domains and forms, update submissions, send test emails).
   - **READ** — only the 9 read-only tools (list/get/overview).
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

| Tool                      | Scope | What it does                                                               |
| ------------------------- | ----- | -------------------------------------------------------------------------- |
| `list_domains`            | READ  | List your domains.                                                         |
| `get_domain`              | READ  | One domain by id, with its verification status.                            |
| `create_domain`           | FULL  | Register a domain (starts verification).                                   |
| `verify_domain`           | FULL  | Verify a domain (starts verification first unless it is already verified). |
| `delete_domain`           | FULL  | Delete a domain and its forms' links to it.                                |
| `list_forms`              | READ  | List your forms.                                                           |
| `get_form`                | READ  | One form by id, with its fields.                                           |
| `create_form`             | FULL  | Create a form on a verified domain.                                        |
| `update_form`             | FULL  | Update a form's name, fields, or settings.                                 |
| `delete_form`             | FULL  | Delete a form.                                                             |
| `list_submissions`        | READ  | List inbox submissions (tab, page).                                        |
| `get_submission`          | READ  | One submission by id.                                                      |
| `update_submission`       | FULL  | Change a submission's status (read, starred, archived, spam).              |
| `bulk_update_submissions` | FULL  | Change the status of several submissions at once.                          |
| `delete_submission`       | FULL  | Delete a submission.                                                       |
| `get_overview`            | READ  | Dashboard overview counts (domains, forms, submissions).                   |
| `get_analytics`           | READ  | Submission analytics for the last N days (default 30).                     |
| `list_email_jobs`         | READ  | List notification email jobs.                                              |
| `send_test_email`         | FULL  | Send a test notification email for a form.                                 |

A READ key calling a FULL tool gets a tool error (`Tool
create_domain not found`) — the tool is not even registered for that
key, so it never reaches the service layer.

Explicitly **not** tools: public submit (submissions arrive
unauthenticated through `POST /api/public/v1/submit` with its spam
heuristics, honeypot, and rate limits — MCP must not become a second,
privileged submission path), user management, and cron/worker
internals.

## Rate limits

Per key: **120 calls/minute** and **2,000 calls/hour** (DB-backed fixed
windows). Over the limit, `tools/call` answers `429`. `initialize` and
`tools/list` are not rate-limited — only tool calls count.

## Errors

| Status  | Meaning                                                                                |
| ------- | -------------------------------------------------------------------------------------- |
| **401** | Missing, unknown, or revoked API key. Create or rotate a key at `/dashboard/api-keys`. |
| **400** | Malformed JSON body, or a body that is not a JSON object.                              |
| **405** | Anything but POST on `/api/mcp` (GET and DELETE are rejected).                         |
| **413** | Body over 4 MiB.                                                                       |
| **429** | Rate limit for this key (see above).                                                   |

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
