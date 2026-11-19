# Folder Structure

```
sendcms/
├── app/                           # Marketing app (the root Next.js app; moves to apps/marketing in Phase 8)
│   ├── changelog/                 # Public changelog page
│   ├── terms/                     # Terms of Service page
│   ├── layout.tsx                 # Root layout + metadata
│   ├── page.tsx                   # Landing page (content/homepage.md)
│   ├── sitemap.ts                 # /sitemap.xml
│   └── robots.ts                  # /robots.txt
├── apps/
│   ├── api/                       # API app: all 21 routes + its own auth wiring (@sendcms/api, dev port 3001)
│   │   ├── app/api/
│   │   │   ├── auth/[...all]/     # Better Auth handler
│   │   │   ├── cron/email-outbox/ # Email retry worker (Bearer CRON_SECRET)
│   │   │   ├── health/            # DB health ping (moved from app/api/health in Phase 6)
│   │   │   ├── public/v1/submit/  # Public submission API (Origin allowlist, no auth)
│   │   │   └── v1/                # Admin REST API (session-gated): domains, forms, inbox, email-jobs
│   │   ├── lib/auth.ts            # Thin wrapper: wires the platform mailer into @sendcms/auth
│   │   ├── proxy.ts               # No-op proxy (empty matcher) — shadows the dashboard proxy
│   │   ├── next.config.mjs        # turbopack.root = workspace root (see ADR 0004)
│   │   └── package.json           # @sendcms/api (dev port 3001)
│   └── dashboard/                 # Dashboard app: auth pages + dashboard + its own auth wiring (@sendcms/dashboard, dev port 3002)
│       ├── app/
│       │   ├── (auth)/            # Sign-in route group (no URL prefix): forgot/reset/sign-in/sign-up/verify-email
│       │   ├── (dashboard)/       # Dashboard layout group (dormant — no pages; moved verbatim)
│       │   │   └── layout.tsx
│       │   ├── dashboard/         # Overview, account, analytics, api, domains, forms, inbox, notifications
│       │   ├── layout.tsx         # Root layout (fonts, favicon, ThemeProvider, Toaster)
│       │   └── globals.css        # Tailwind + design tokens (copy of the root app's)
│       ├── components/dashboard/  # app-sidebar, page-header, stat-card, charts, install-snippet, query-provider
│       ├── lib/auth.ts            # Thin wrapper: wires the platform mailer into @sendcms/auth
│       ├── proxy.ts               # Next middleware — gates /dashboard/:path* (moved from the root)
│       ├── config/config.json     # Brand config copy (favicon, logo) — same values as the root app's
│       ├── styles/                # Design tokens + component CSS (copy of the root's styles/)
│       ├── public/images/         # Brand images (favicon, logo, logo-darkmode)
│       ├── next.config.mjs        # turbopack.root = workspace root (see ADR 0004)
│       └── package.json           # @sendcms/dashboard (dev port 3002)
├── components/
│   ├── product-schema.tsx         # JSON-LD product schema (landing page only)
│   ├── theme-toggle.tsx           # Theme toggle button (landing page only)
│   └── (no ui/ — primitives live in packages/ui, imported as @sendcms/ui)
├── packages/
│   ├── config/                    # Shared tsconfig base + ESLint base (@sendcms/config)
│   ├── shared/                    # Framework-free helpers: cn(), ApiError, apiFetch, submission-display, HONEYPOT_FIELD constants (@sendcms/shared)
│   ├── api-client/                # API-layer plumbing: CORS, response/error helpers (@sendcms/api-client)
│   ├── sdk/                       # Form SDK (vanilla TS) → public/forms/v1.js + snippet builders (@sendcms/sdk)
│   ├── ui/                        # shadcn/ui primitives + use-mobile + Logo + ThemeProvider (@sendcms/ui)
│   ├── database/                  # Prisma schema + migrations + client + pingDatabase (@sendcms/database)
│   ├── auth/                      # Better Auth factory + providers + browser client (@sendcms/auth)
│   ├── permissions/               # Platform roles + capabilities (@sendcms/permissions)
│   ├── email/                     # Platform email: provider (Resend/SMTP/none) + auth mailer + notification deps (@sendcms/email)
│   └── modules/                   # Business modules (server service + validators + client queries)
│       ├── domains/               # domain service + dns-verification (@sendcms/domains)
│       ├── forms/                 # form CRUD, fields, domain links (@sendcms/forms)
│       ├── submissions/           # public submit flow + Turnstile (@sendcms/submissions)
│       ├── inbox/                 # inbox reads + status/bulk actions (@sendcms/inbox)
│       ├── notifications/         # EmailJob outbox, retries, test email — sender + renderer injected (@sendcms/notifications)
│       ├── users/                 # auth methods, user lookup, auth validators (@sendcms/users)
│       └── analytics/             # overview + analytics aggregates (@sendcms/analytics)
├── lib/
│   ├── content.ts                 # Markdown content loader (homepage, terms, changelog)
│   ├── text-converter.ts          # Markdown → HTML
│   └── utils.ts                   # getBaseUrl() (cn() moved to packages/shared)
├── config/config.json             # App configuration (site, metadata, branding, email)
├── content/                       # Editable markdown: homepage.md, terms.md, changelog.md
├── docs/                          # Getting started, REST API, SDK, security, deployment, troubleshooting
└── public/                        # Static assets (images, favicon.ico, _headers, forms/v1.js)
```

## Key Path Aliases

| Alias                       | Points to                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `@/`                        | The app's own root (each app — root, `apps/api`, `apps/dashboard` — has its own `@/*` alias)        |
| `@/lib/*`                   | That app's shared utilities (`lib/auth.ts` is per-app: each app wires its own Better Auth instance) |
| `@/components/*`            | That app's UI components                                                                            |
| `@sendcms/database`         | Prisma client + `db` singleton (`packages/database`)                                                |
| `@sendcms/auth`             | Better Auth factory + providers (`packages/auth`)                                                   |
| `@sendcms/auth/client`      | Browser-side Better Auth client (`packages/auth`)                                                   |
| `@sendcms/permissions`      | Platform roles + capabilities (`packages/permissions`)                                              |
| `@sendcms/email`            | Platform email: `sendPlatformEmail`, auth mailer, `notificationDeps` (`packages/email`)             |
| `@sendcms/ui`               | shadcn/ui primitives + `useIsMobile` + `Logo` + `ThemeProvider` (`packages/ui`)                     |
| `@sendcms/shared`           | `cn()`, `ApiError`, `apiFetch`, `getSubmissionSender` (`packages/shared`)                           |
| `@sendcms/shared/constants` | `HONEYPOT_FIELD` — the shared server/SDK honeypot contract (`packages/shared`)                      |
| `@sendcms/api-client`       | `ok`, `created`, `noContent`, `handleApiError`, `ApiError`, CORS helpers (`packages/api-client`)    |
| `@sendcms/sdk`              | Form SDK bundle source (`packages/sdk`)                                                             |
| `@sendcms/sdk/snippet`      | SDK + REST snippet builders (`packages/sdk`)                                                        |
| `@sendcms/api`              | API app (`apps/api`)                                                                                |
| `@sendcms/dashboard`        | Dashboard app (`apps/dashboard`)                                                                    |
| `@sendcms/domains`          | Domain service + validators + queries (`packages/modules/domains`)                                  |
| `@sendcms/forms`            | Form service + validators + queries (`packages/modules/forms`)                                      |
| `@sendcms/submissions`      | Public submit flow + Turnstile (`packages/modules/submissions`)                                     |
| `@sendcms/inbox`            | Inbox service + validators + queries (`packages/modules/inbox`)                                     |
| `@sendcms/notifications`    | EmailJob outbox (`packages/modules/notifications`)                                                  |
| `@sendcms/users`            | User service + auth validators (`packages/modules/users`)                                           |
| `@sendcms/analytics`        | Overview + analytics (`packages/modules/analytics`)                                                 |
| `@sendcms/config`           | Shared tsconfig + ESLint base (`packages/config`)                                                   |
