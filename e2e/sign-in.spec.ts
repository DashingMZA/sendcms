// TST-007 (Phase 16, Wave 11, Stream C): the first browser journey —
// sign-in with email → dashboard overview.
//
// Credentials come from the environment, never from a committed file:
//   E2E_USER_EMAIL / E2E_USER_PASSWORD
// Create the user first (see e2e/README.md):
//   E2E_USER_EMAIL=… E2E_USER_PASSWORD=… pnpm e2e:setup
import { expect, test } from "@playwright/test"

const email = process.env.E2E_USER_EMAIL
const password = process.env.E2E_USER_PASSWORD

test.beforeAll(() => {
  if (!email || !password) {
    throw new Error(
      "E2E_USER_EMAIL and E2E_USER_PASSWORD must be set — see e2e/README.md"
    )
  }
})

test("signed-out visit to /dashboard redirects to sign-in", async ({
  page,
}) => {
  await page.goto("/dashboard")
  await expect(page).toHaveURL(/\/sign-in/)
  await expect(page.locator("#signin-email")).toBeVisible()
})

test("sign-in with email lands on the dashboard overview", async ({ page }) => {
  await page.goto("/sign-in")
  await page.locator("#signin-email").fill(email!)
  await page.locator("#signin-password").fill(password!)
  await page.getByRole("button", { name: "Sign in with email" }).click()
  await expect(page).toHaveURL(/\/dashboard/)
  // The overview renders its translated title as the page <h1> (SRC-113);
  // the default locale is English, so the heading is "Overview".
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible()
})
