// TST-007 (Phase 16, Wave 11, Stream C): the first browser journey —
// sign-in → dashboard — run with Playwright (latest stable, 1.65.x).
//
// The apps are NOT started by this config. Start the api + dashboard
// against a scratch database first (see e2e/README.md), or set
// E2E_START_SERVERS=1 to let Playwright start the production builds
// (they must already exist: `pnpm --filter @sendcms/api build:server`
// and `pnpm --filter @sendcms/dashboard build:server`).
import { defineConfig } from "@playwright/test"

const dashboardUrl = process.env.E2E_BASE_URL ?? "http://localhost:3002"

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // One journey, one worker — the tests share a single signed-in user
  // and must not race each other.
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: dashboardUrl,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        // E2E_CHROMIUM_PATH: use an already-installed Chromium instead
        // of the Playwright-managed one (e.g. this sandbox ships one
        // at /opt/meta-chromium/chrome; `playwright install chromium`
        // is the normal path and downloads the matching build).
        // NOTE: executablePath is a LAUNCH option — it must sit under
        // launchOptions; a bare `use.executablePath` is silently
        // ignored and Playwright falls back to its (missing) managed
        // headless-shell binary.
        launchOptions: { executablePath: process.env.E2E_CHROMIUM_PATH },
      },
    },
  ],
  webServer: process.env.E2E_START_SERVERS
    ? {
        command: "bash e2e/start-servers.sh",
        url: `${dashboardUrl}/sign-in`,
        reuseExistingServer: true,
        timeout: 180_000,
      }
    : undefined,
})
