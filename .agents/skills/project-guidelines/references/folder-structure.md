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
│   └── ui/                        # shadcn/ui primitives + use-mobile (@sendcms/ui)
├── lib/
│   ├── db.ts                      # Prisma singleton
│   ├── auth.ts                    # Better Auth config (with Prisma) + auth() helper
│   ├── auth-client.ts             # Browser-side Better Auth client
│   ├── auth-providers.ts          # Env-gated OAuth providers
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
│   ├── permissions/               # platform.ts, index.ts (platform-only)
│   ├── email/                     # provider.ts, platform-transport.ts, transport.ts, auth-mailer.ts, templates/
│   ├── cors.ts                    # getEffectiveOrigin, normalizeOrigin, corsHeaders
│   ├── sdk-snippet.ts             # SDK + REST snippet builders
│   ├── submission-display.ts      # sender/preview helpers (client-safe)
│   ├── content.ts                 # Markdown content loader (homepage, terms, changelog)
│   ├── text-converter.ts          # Markdown → HTML
│   └── utils.ts                   # getBaseUrl() (cn() moved to packages/shared)
├── generated/prisma/              # Prisma client output (do not edit)
├── prisma/                        # Schema + migrations + seed
├── sdk/                           # Form SDK (vanilla TS) → public/forms/v1.js
├── config/config.json             # App configuration (site, metadata, branding, email)
├── content/                       # Editable markdown: homepage.md, terms.md, changelog.md
├── docs/                          # Getting started, REST API, SDK, security, deployment, troubleshooting
├── proxy.ts                       # Next middleware (not middleware.ts)
└── public/                        # Static assets (images, favicon.ico, _headers)
```

## Key Path Aliases

| Alias                | Points to                                               |
| -------------------- | ------------------------------------------------------- |
| `@/`                 | Project root                                            |
| `@/lib/*`            | Shared utilities                                        |
| `@/components/*`     | UI components                                           |
| `@/generated/prisma` | Prisma client                                           |
| `@sendcms/ui`        | shadcn/ui primitives + `useIsMobile` (`packages/ui`)    |
| `@sendcms/shared`    | Framework-free helpers, e.g. `cn()` (`packages/shared`) |
| `@sendcms/config`    | Shared tsconfig + ESLint base (`packages/config`)       |
