# Folder Structure

```
open-remark/
├── app/
│   ├── (auth)/                    # Sign-in route group (no URL prefix)
│   │   └── sign-in/
│   ├── (dashboard)/               # Dashboard layout group
│   ├── dashboard/
│   │   ├── page.tsx               # Dashboard home
│   │   ├── settings/
│   │   ├── administration/
│   │   ├── notice-board/
│   │   ├── account/
│   │   └── sites/
│   │       ├── new/
│   │       └── [siteId]/
│   │           ├── page.tsx           # Overview
│   │           ├── domains/           # register / verify / detail
│   │           ├── forms/             # CRUD / fields / domain links / notifications
│   │           ├── inbox/             # submissions + detail
│   │           ├── notifications/     # email delivery log
│   │           ├── analytics/         # 30-day stats
│   │           ├── api/               # SDK snippet + REST reference
│   │           └── account/           # profile, email, password, connected accounts
│   ├── api/
│   │   ├── v1/                    # Admin REST API (session-gated): domains, forms, inbox, email-jobs
│   │   ├── public/v1/submit/      # Public submission API (Origin allowlist, no auth)
│   │   ├── cron/email-outbox/     # Email retry worker (Bearer <redacted>)
│   │   ├── health/                # DB health ping
│   │   └── auth/[...all]/        # Better Auth handler
│   └── changelog/
├── components/
│   ├── dashboard/                 # Dashboard-specific components
│   └── ui/                        # shadcn/ui primitives
├── lib/
│   ├── db.ts                      # Prisma singleton
│   ├── auth.ts                    # Better Auth config (with Prisma) + auth() helper
│   ├── auth-client.ts             # Browser-side Better Auth client
│   ├── services/                  # Business logic (server-side, no Next.js imports)
│   │   ├── domain-service.ts      # register/verify/suspend domains
│   │   ├── form-service.ts        # form CRUD, fields, domain links, notifications
│   │   ├── submission-service.ts  # public submit flow + inbox actions
│   │   ├── dns-verification.ts    # DNS TXT / meta-tag / file checks (DoH)
│   │   ├── email-outbox.ts        # EmailJob queue, retries, test email
│   │   ├── dashboard-service.ts   # overview + analytics aggregates
│   │   ├── user-service.ts        # auth methods, user lookup
│   │   └── system-service.ts      # DB health ping
│   ├── api-client.ts              # apiFetch<T>() — typed client fetch wrapper, throws ApiClientError
│   ├── queries/                   # Client-side React Query hooks, one file per resource
│   │   ├── domains.ts
│   │   ├── forms.ts
│   │   ├── inbox.ts
│   │   └── email-jobs.ts
│   ├── validators/                # Zod schemas (auth, domain, form, inbox, email-jobs, submission)
│   ├── api/                       # response.ts + error.ts
│   ├── permissions/               # platform.ts, index.ts (site rules removed with the comment system)
│   ├── email/                     # provider.ts, platform-transport.ts, transport.ts, auth-mailer.ts, templates/
│   ├── cors.ts                    # getEffectiveOrigin, normalizeOrigin, corsHeaders
│   └── utils.ts
├── hooks/
│   └── use-mobile.ts
├── generated/prisma/              # Prisma client output (do not edit)
├── prisma/                        # Schema + migrations
├── sdk/                           # Form SDK (vanilla TS) → public/forms/v1.js
├── config/config.json             # App configuration
├── proxy.ts                       # Next middleware (not middleware.ts)
└── public/                        # Static assets
```

## Key Path Aliases

| Alias | Points to |
|---|---|
| `@/` | Project root |
| `@/lib/*` | Shared utilities |
| `@/components/*` | UI components |
| `@/generated/prisma` | Prisma client |
