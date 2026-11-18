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
│   │   ├── health/                # DB health ping
│   │   └── auth/[...all]/         # Better Auth handler
│   ├── changelog/                 # Public changelog page
│   ├── terms/                     # Terms of Service page
│   ├── layout.tsx                 # Root layout + metadata
│   ├── page.tsx                   # Landing page (content/homepage.md)
│   ├── sitemap.ts                 # /sitemap.xml
│   └── robots.ts                  # /robots.txt
├── components/
│   ├── dashboard/                 # app-sidebar, page-header, stat-card, charts, install-snippet
│   ├── logo.tsx                   # Config-driven logo (light/dark variants)
│   ├── product-schema.tsx         # JSON-LD product schema
│   ├── theme-provider.tsx
│   ├── theme-toggle.tsx
│   └── (no ui/ — primitives live in packages/ui, imported as @sendcms/ui)
├── packages/
│   ├── config/                    # Shared tsconfig base + ESLint base (@sendcms/config)
│   ├── shared/                    # Framework-free helpers: cn() (@sendcms/shared)
│   ├── ui/                        # shadcn/ui primitives + use-mobile (@sendcms/ui)
│   ├── database/                  # Prisma schema + migrations + client (@sendcms/database)
│   ├── auth/                      # Better Auth factory + providers + browser client (@sendcms/auth)
│   └── permissions/               # Platform roles + capabilities (@sendcms/permissions)
├── lib/
│   ├── auth.ts                    # Thin wrapper: wires the app mailer into @sendcms/auth; betterAuth/auth()/AdminSession
│   ├── services/                  # Business logic (server-side, no Next.js imports)
│   │   ├── domain-service.ts      # register/verify/suspend domains
│   │   ├── form-service.ts        # form CRUD, fields, domain links, notifications
│   │   ├── submission-service.ts  # public submit flow + inbox actions
│   │   ├── dns-verification.ts    # DNS TXT / meta-tag / file checks (DoH)
│   │   ├── email-outbox.ts        # EmailJob queue, retries, test email
│   │   ├── dashboard-service.ts   # overview + analytics aggregates
│   │   ├── user-service.ts        # auth methods, user lookup
│   │   ├── system-service.ts      # DB health ping
│   │   └── turnstile.ts           # Cloudflare Turnstile verification
│   ├── api-client.ts              # apiFetch<T>() — typed client fetch wrapper, throws ApiClientError
│   ├── queries/                   # Client-side React Query hooks, one file per resource
│   │   ├── domains.ts
│   │   ├── forms.ts
│   │   ├── inbox.ts
│   │   └── email-jobs.ts
│   ├── validators/                # Zod schemas (auth, domain, form, inbox, email-jobs, submission)
│   ├── api/                       # response.ts + error.ts
│   ├── email/                     # provider.ts, platform-transport.ts, transport.ts, auth-mailer.ts, templates/
│   ├── cors.ts                    # getEffectiveOrigin, normalizeOrigin, corsHeaders
│   ├── sdk-snippet.ts             # SDK + REST snippet builders
│   ├── submission-display.ts      # sender/preview helpers (client-safe)
│   ├── content.ts                 # Markdown content loader (homepage, terms, changelog)
│   ├── text-converter.ts          # Markdown → HTML
│   └── utils.ts                   # getBaseUrl() (cn() moved to packages/shared)
├── sdk/                           # Form SDK (vanilla TS) → public/forms/v1.js
├── config/config.json             # App configuration (site, metadata, branding, email)
├── content/                       # Editable markdown: homepage.md, terms.md, changelog.md
├── docs/                          # Getting started, REST API, SDK, security, deployment, troubleshooting
├── proxy.ts                       # Next middleware (not middleware.ts)
└── public/                        # Static assets (images, favicon.ico, _headers)
```

## Key Path Aliases

| Alias                  | Points to                                               |
| ---------------------- | ------------------------------------------------------- |
| `@/`                   | Project root                                            |
| `@/lib/*`              | Shared utilities                                        |
| `@/components/*`       | UI components                                           |
| `@sendcms/database`    | Prisma client + `db` singleton (`packages/database`)    |
| `@sendcms/auth`        | Better Auth factory + providers (`packages/auth`)       |
| `@sendcms/auth/client` | Browser-side Better Auth client (`packages/auth`)       |
| `@sendcms/permissions` | Platform roles + capabilities (`packages/permissions`)  |
| `@sendcms/ui`          | shadcn/ui primitives + `useIsMobile` (`packages/ui`)    |
| `@sendcms/shared`      | Framework-free helpers, e.g. `cn()` (`packages/shared`) |
| `@sendcms/config`      | Shared tsconfig + ESLint base (`packages/config`)       |
