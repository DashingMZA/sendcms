# SendCMS — one Dockerfile for every app + the email worker.
#
# Build arg APP selects the target package:
#   docker build --build-arg APP=@sendcms/api -t sendcms-api .
#   docker build --build-arg APP=@sendcms/email-worker -t sendcms-worker .
#
# LVE-021: APP has NO default by design — building without it used to
# pass an empty filter to pnpm and fail opaquely. The app-build stage
# below fails fast with a clear error when APP is empty instead.
#
# NEXT_PUBLIC_* values are inlined into the browser bundle at build time,
# so the Dockerfile declares each one as an ARG (builders such as Railway
# only pass variables the Dockerfile declares). They are also set as ENV
# so the same values are visible at runtime; a runtime variable with the
# same name overrides the baked-in one. Secrets (DATABASE_URL, *_SECRET,
# *_KEY) are never build args — they are read from the environment at
# runtime.
#
# The install runs with --ignore-scripts: the root `prepare` script runs
# husky, which needs a .git directory, and .git is not in the image.
# No dependency in this workspace needs a postinstall script (the Prisma
# client is generated explicitly with `db:generate`).

FROM node:24-alpine AS base
RUN apk add --no-cache libc6-compat
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@12.19.0 --activate
WORKDIR /app

# Install + generate. No app build here, so the `migrate`/`seed` one-off
# services can target this stage without building an app.
FROM base AS builder
# Full workspace copy (source is small; a manifest-only copy would cache
# the install layer better but needs one COPY line per package.json).
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm --filter @sendcms/database db:generate

# Build the selected app. The worker runs from TypeScript source (tsx)
# and has no build step.
FROM builder AS app-build
ARG APP
# LVE-021: guard — no APP means no app to build; fail here with a
# clear message instead of an opaque `pnpm --filter ""` failure.
RUN if [ -z "$APP" ]; then echo "ERROR: missing --build-arg APP (e.g. APP=@sendcms/api or APP=@sendcms/email-worker). See the header comment." >&2; exit 1; fi
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_DASHBOARD_URL
ARG NEXT_PUBLIC_DOCS_URL
ARG NEXT_PUBLIC_UPDATES_URL
ARG NEXT_PUBLIC_AUTH_URL
ARG NEXT_PUBLIC_ADMIN_URL
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
  NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
  NEXT_PUBLIC_DASHBOARD_URL=$NEXT_PUBLIC_DASHBOARD_URL \
  NEXT_PUBLIC_DOCS_URL=$NEXT_PUBLIC_DOCS_URL \
  NEXT_PUBLIC_UPDATES_URL=$NEXT_PUBLIC_UPDATES_URL \
  NEXT_PUBLIC_AUTH_URL=$NEXT_PUBLIC_AUTH_URL \
  NEXT_PUBLIC_ADMIN_URL=$NEXT_PUBLIC_ADMIN_URL \
  NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY
# `next build` needs a DATABASE_URL value in the environment (no page is
# expected to query the DB at build time — this is a dummy, never a real
# credential; the same dummy the local builds use).
ENV DATABASE_URL=postgresql://user:pass@localhost:5432/sendcms?sslmode=require
RUN if [ "$APP" != "@sendcms/email-worker" ]; then pnpm --filter "$APP" build:server; fi
# Drop the per-app node_modules (dev deps) — the runner installs prod
# deps itself, and copying these across would carry dev deps + stale
# symlinks into the image.
RUN rm -rf apps/*/node_modules packages/*/node_modules services/*/node_modules

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ARG APP
ENV APP=$APP
# LVE-021: the image self-describes its port and health endpoint, so
# a single-app `docker run` (platforms.md "Single-app image") has a
# health signal without compose. Per-app path: the api app answers
# /api/health (DB ping), the email worker answers /health, every other
# Next app answers its root page. wget is BusyBox in node:24-alpine.
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD sh -c 'case "$APP" in @sendcms/api) path=/api/health ;; @sendcms/email-worker) path=/health ;; *) path=/ ;; esac; wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}$path" || exit 1'
COPY . .
RUN pnpm install --prod --frozen-lockfile --ignore-scripts
# Built app output (only the selected app has a .next) + the generated
# Prisma client (the worker imports it from TypeScript source at runtime;
# the Next apps' bundles already contain it, but the copy is harmless
# and keeps the image uniform).
COPY --from=app-build /app/apps ./apps
COPY --from=builder /app/packages/database/generated ./packages/database/generated
CMD ["sh", "-c", "if [ \"$APP\" = \"@sendcms/email-worker\" ]; then exec pnpm --filter @sendcms/email-worker start; else exec pnpm --filter $APP start -- -H 0.0.0.0 -p ${PORT:-3000}; fi"]
