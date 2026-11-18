# Folder Structure

```
sendcms/
├── app/
│   ├── (auth)/                    # Sign-in route group (no URL prefix)
│   │   ├── forgot-password/
│   │   ├── reset-password/
│   │   ├── sign-in/
│   │   ├── sign-up/
│   │   └── verify-email/
│   ├── (dashboard)/               # Dashboard layout group
│   │   └── layout.tsx
│   ├── dashboard/
│   │   ├── page.tsx               # Overview (stats + 14-day chart + recent submissions)
│   │   ├── account/               # profile, email, password, connected accounts
│   │   ├── analytics/             # 30-day stats
│   │   ├── api/                   # SDK snippet + REST reference
│   │   ├── domains/               # list, new, [domainId] detail
│   │   ├── forms/                 # list, new, [formId] detail
│   │   ├── inbox/                 # submissions + [submissionId] detail
│   │   └── notifications/         # email delivery log
│   ├── api/
│   │   ├── v1/                    # Admin REST API (session-gated): domains, forms, inbox, email-jobs
│   │   ├── public/v1/submit/      # Public submission API (Origin allowlist, no auth)
│   │   ├── cron/email-outbox/     # Email retry worker (Bearer CRON_SECRET)
│   │   └── auth/[...all]/         # Better Auth handler
│   ├── changelog/                 # Public changelog page
│   ├── terms/                     # Terms of Service page
│   ├── layout.tsx                 # Root layout + metadata
│   ├── page.tsx                   # Landing page (content/homepage.md)
│   ├── sitemap.ts                 # /sitemap.xml
│   └── robots.ts                  # /robots.txt
├── apps/
│   └── api/                       # API app skeleton: health route only (routes move in Phase 7)
│       ├── app/api/health/        # DB health ping (moved from app/api/health)
│       ├── proxy.ts               # No-op proxy (empty matcher) — shadows the dashboard proxy
│       ├── next.config.mjs        # turbopack.root = workspace root (see ADR 0004)
│       └── package.json           # @sendcms/api (dev port 3001)
├── components/
│   ├── dashboard/                 # app-sidebar, page-header, stat-card, charts, install-snippet
│   ├── logo.tsx                   # Config-driven logo (light/dark variants)
│   ├── product-schema.tsx         # JSON-LD product schema
│   ├── theme-provider.tsx
│   ├── theme-toggle.tsx
│   └── (no ui/ — primitives live in packages/ui, imported as @sendcms/ui)
├── packages/
│   ├── config/                    # Shared tsconfig base + ESLint base (@sendcms/config)
│   ├── shared/                    # Framework-free helpers: cn(), ApiError, apiFetch, submission-display, HONEYPOT_FIELD constants (@sendcms/shared)
│   ├── api-client/                # API-layer plumbing: CORS, response/error helpers (@sendcms/api-client)
│   ├── sdk/                       # Form SDK (vanilla TS) → public/forms/v1.js + snippet builders (@sendcms/sdk)
│   ├── ui/                        # shadcn/ui primitives + use-mobile (@sendcms/ui)
│   ├── database/                  # Prisma schema + migrations + client + pingDatabase (@sendcms/database)
│   ├── auth/                      # Better Auth factory + providers + browser client (@sendcms/auth)
│   ├── permissions/               # Platform roles + capabilities (@sendcms/permissions)
│   └── modules/                   # Business modules (server service + validators + client queries)
│       ├── domains/               # domain service + dns-verification (@sendcms/domains)
│       ├── forms/                 # form CRUD, fields, domain links (@sendcms/forms)
│       ├── submissions/           # public submit flow + Turnstile (@sendcms/submissions)
│       ├── inbox/                 # inbox reads + status/bulk actions (@sendcms/inbox)
│       ├── notifications/         # EmailJob outbox, retries, test email — sender + renderer injected (@sendcms/notifications)
│       ├── users/                 # auth methods, user lookup, auth validators (@sendcms/users)
│       └── analytics/             # overview + analytics aggregates (@sendcms/analytics)
├── lib/
│   ├── auth.ts                    # Thin wrapper: wires the app mailer into @sendcms/auth; betterAuth/auth()/AdminSession
│   ├── email/                     # provider.ts, platform-transport.ts, transport.ts, auth-mailer.ts, templates/, notification-deps.ts
│   ├── content.ts                 # Markdown content loader (homepage, terms, changelog)
│   ├── text-converter.ts          # Markdown → HTML
│   └── utils.ts                   # getBaseUrl() (cn() moved to packages/shared)
├── config/config.json             # App configuration (site, metadata, branding, email)
├── content/                       # Editable markdown: homepage.md, terms.md, changelog.md
├── docs/                          # Getting started, REST API, SDK, security, deployment, troubleshooting
├── proxy.ts                       # Next middleware (not middleware.ts)
└── public/                        # Static assets (images, favicon.ico, _headers)
```

## Key Path Aliases

| Alias                    | Points to                                                                 |
| ------------------------ | ------------------------------------------------------------------------- |
| `@/`                     | Project root                                                              |
| `@/lib/*`                | Shared utilities                                                          |
| `@/components/*`         | UI components                                                             |
| `@sendcms/database`      | Prisma client + `db` singleton (`packages/database`)                      |
| `@sendcms/auth`          | Better Auth factory + providers (`packages/auth`)                         |
| `@sendcms/auth/client`   | Browser-side Better Auth client (`packages/auth`)                         |
| `@sendcms/permissions`   | Platform roles + capabilities (`packages/permissions`)                    |
| `@sendcms/ui`            | shadcn/ui primitives + `useIsMobile` (`packages/ui`)                      |
| `@sendcms/shared`        | `cn()`, `ApiError`, `apiFetch`, `getSubmissionSender` (`packages/shared`) |
| `@sendcms/shared/constants` | `HONEYPOT_FIELD` — the shared server/SDK honeypot contract (`packages/shared`) |
| `@sendcms/api-client`    | `ok`, `created`, `noContent`, `handleApiError`, `ApiError`, CORS helpers (`packages/api-client`) |
| `@sendcms/sdk`           | Form SDK bundle source (`packages/sdk`) |
| `@sendcms/sdk/snippet`   | SDK + REST snippet builders (`packages/sdk`) |
| `@sendcms/api`           | API app skeleton (`apps/api`) |
| `@sendcms/domains`       | Domain service + validators + queries (`packages/modules/domains`)        |
| `@sendcms/forms`         | Form service + validators + queries (`packages/modules/forms`)            |
| `@sendcms/submissions`   | Public submit flow + Turnstile (`packages/modules/submissions`)           |
| `@sendcms/inbox`         | Inbox service + validators + queries (`packages/modules/inbox`)           |
| `@sendcms/notifications` | EmailJob outbox (`packages/modules/notifications`)                        |
| `@sendcms/users`         | User service + auth validators (`packages/modules/users`)                 |
| `@sendcms/analytics`     | Overview + analytics (`packages/modules/analytics`)                       |
| `@sendcms/config`        | Shared tsconfig + ESLint base (`packages/config`)                         |
