# E2E tests (Playwright) — TST-007, Phase 16 Wave 11

First browser journey: **sign-in with email → dashboard overview**
(`e2e/sign-in.spec.ts`, Chromium only for now).

## Running locally

The suite does **not** start the apps itself. Run it against a **scratch**
database — never the shared dev database or production:

```bash
# 1. Scratch database (local Postgres)
sudo -u postgres psql -c "CREATE DATABASE sendcms_e2e;"
sudo -u postgres psql -c "CREATE ROLE sendcms_e2e LOGIN PASSWORD 'e2e';"
export DATABASE_URL="postgresql://sendcms_e2e:e2e@localhost:5432/sendcms_e2e"

# 2. Migrate + build the two apps the journey needs
pnpm db:migrate:deploy
pnpm --filter @sendcms/api build:server
pnpm --filter @sendcms/dashboard build:server

# 3. Start both apps (api 3001, dashboard 3002) with the usual env
#    (BETTER_AUTH_SECRET, BETTER_AUTH_URL=http://localhost:3001,
#    NEXT_PUBLIC_APP_URL=http://localhost:3001, … — see .env.example).
#    NEXT_PUBLIC_DASHBOARD_URL must match the dashboard's own origin:
#    the sign-in page computes the post-sign-in callbackURL from it at
#    SSR time, and the api only accepts callback origins listed in
#    TRUSTED_ORIGINS — a mismatch fails sign-in with
#    "Invalid callbackURL". (On non-default ports, set it to the
#    dashboard's actual URL, e.g. http://localhost:3132, at BUILD time
#    — NEXT_PUBLIC_* values are baked into the bundle.)
#    Or set E2E_START_SERVERS=1 and let Playwright run e2e/start-servers.sh.

# 4. Create the E2E user (sign-up via the api + flip emailVerified —
#    the seeded demo user has no password, so the journey can't use it)
E2E_USER_EMAIL=e2e@example.com E2E_USER_PASSWORD='<secret>' pnpm e2e:setup

# 5. Install the browser once, then run
pnpm exec playwright install chromium
E2E_USER_EMAIL=e2e@example.com E2E_USER_PASSWORD='<secret>' pnpm e2e
```

Ports and origins are overridable: `E2E_BASE_URL` (dashboard, default
`http://localhost:3002`), `E2E_API_URL` (default `http://localhost:3001`).

## CI wiring (for Wave 12 — `.github/workflows/ci.yml` is NOT edited here)

Add a job after the existing `test` job, reusing its Postgres 17 service
and `pnpm db:migrate:deploy` step:

```yaml
e2e:
  needs: test
  runs-on: ubuntu-latest
  services:
    postgres:
      image: postgres:17
      env:
        POSTGRES_PASSWORD: postgres
      ports: ["5432:5432"]
      options: >-
        --health-cmd pg_isready --health-interval 10s
        --health-timeout 5s --health-retries 5
  env:
    DATABASE_URL: postgresql://postgres:postgres@localhost:5432/sendcms
    BETTER_AUTH_SECRET: ${{ secrets.E2E_BETTER_AUTH_SECRET }}
    BETTER_AUTH_URL: http://localhost:3001
    NEXT_PUBLIC_APP_URL: http://localhost:3001
    NEXT_PUBLIC_DASHBOARD_URL: http://localhost:3002
    E2E_USER_EMAIL: e2e@example.com
    E2E_USER_PASSWORD: ${{ secrets.E2E_USER_PASSWORD }}
  steps:
    - uses: actions/checkout@v4
    - uses: pnpm/action-setup@v4
    - uses: actions/setup-node@v4
      with: { node-version: 24, cache: pnpm }
    - run: pnpm install --frozen-lockfile
    - run: pnpm db:generate
    - run: pnpm db:migrate:deploy
    - run: pnpm --filter @sendcms/api build:server
    - run: pnpm --filter @sendcms/dashboard build:server
    - run: pnpm exec playwright install --with-deps chromium
    - run: pnpm e2e:setup
    - run: pnpm e2e
```

Two secrets are needed in the repo settings: `E2E_BETTER_AUTH_SECRET`
(any random 32+ char string) and `E2E_USER_PASSWORD`.

## Status

- Harness + journey written in Wave 11 (Stream C) and run GREEN in the
  sandbox against production builds on a scratch database:
  `2 passed (10.0s)` — signed-out `/dashboard` → `/sign-in`, and
  sign-in with email → dashboard "Overview" (logs:
  `.audit-phase16/wave11/stream-c/logs/e2e-run4.log`).
- Browser install note: `playwright install chromium` fails in this
  sandbox — the Node downloader TLS-times-out against
  cdn.playwright.dev, although curl reaches it fine. Workaround used
  here: download the two Chrome-for-Testing zips with curl and unzip
  them into `~/.cache/ms-playwright/` (`chromium-1255/chrome-linux`
  - `chromium_headless_shell-1255/chrome-headless-shell-linux64`,
    v159.0.8154.6). In CI the plain `playwright install` step applies.
    The sandbox's own `/opt/meta-chromium/chrome` does NOT work under
    Playwright (refuses to start: "Hatch WebGL domain policy is
    required"); `E2E_CHROMIUM_PATH` stays as an escape hatch only.
- Visual/browser sign-off stays owner-side.

```

```
