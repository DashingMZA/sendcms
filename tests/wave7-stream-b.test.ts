// Wave 7 Stream B (i18n / RTL): stored-locale shell, selector SSR
// label, persist race, coming-soon locales, setUserLocale errors,
// account-form native validation.
//
// Conventions: mocked Prisma client (same pattern as
// users-lookup.test.ts); source guards read the app tree like
// security.test.ts does (vitest runs with the repo root as cwd).
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { SELECTABLE_LOCALES, isSelectableLocale } from "@sendcms/i18n"
import { awaitWithTimeout } from "@sendcms/shared"
import { SelectableLocales, SetLocaleSchema } from "@sendcms/users/validators"

const mockDb = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), update: vi.fn() },
}))
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})

import { setUserLocale } from "@sendcms/users"

function read(rel: string): string {
  return readFileSync(rel, "utf8")
}

/** Every .ts/.tsx file under a directory, recursively (skips generated output). */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (/\.tsx?$/.test(entry)) out.push(path)
  }
  return out
}

describe("isSelectableLocale / SelectableLocales (I18N-307)", () => {
  it("accepts only locales with complete translation files", () => {
    expect(isSelectableLocale("en")).toBe(true)
    expect(isSelectableLocale("ur")).toBe(true)
    expect(isSelectableLocale("ar")).toBe(false)
    expect(isSelectableLocale("es")).toBe(false)
    expect(isSelectableLocale("xx")).toBe(false)
    expect(isSelectableLocale("")).toBe(false)
  })

  it("stays in sync with the users validator (drift guard)", () => {
    expect([...SelectableLocales]).toEqual(
      SELECTABLE_LOCALES.map((locale) => locale.code)
    )
  })

  it("SetLocaleSchema accepts en/ur and rejects coming-soon codes", () => {
    expect(SetLocaleSchema.safeParse({ locale: "en" }).success).toBe(true)
    expect(SetLocaleSchema.safeParse({ locale: "ur" }).success).toBe(true)
    expect(SetLocaleSchema.safeParse({ locale: "ar" }).success).toBe(false)
    expect(SetLocaleSchema.safeParse({ locale: "es" }).success).toBe(false)
    expect(SetLocaleSchema.safeParse({ locale: "xx" }).success).toBe(false)
    expect(SetLocaleSchema.safeParse({}).success).toBe(false)
  })
})

describe("setUserLocale (SRC-227)", () => {
  it("returns 404 for an unknown user without calling update", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce(null)
    const error = await setUserLocale("nonexistent", "en").catch(
      (err: unknown) => err
    )
    expect(error).toMatchObject({ status: 404 })
    expect(mockDb.user.update).not.toHaveBeenCalled()
  })

  it("returns 422 for an invalid locale without touching the DB", async () => {
    const error = await setUserLocale("user-1", "xx-invalid").catch(
      (err: unknown) => err
    )
    expect(error).toMatchObject({ status: 422 })
    expect(mockDb.user.findUnique).not.toHaveBeenCalled()
    expect(mockDb.user.update).not.toHaveBeenCalled()
  })

  it("returns 422 for a coming-soon locale (I18N-307, service level)", async () => {
    const error = await setUserLocale("user-1", "ar").catch(
      (err: unknown) => err
    )
    expect(error).toMatchObject({ status: 422 })
    expect(mockDb.user.update).not.toHaveBeenCalled()
  })

  it("stores a selectable locale for a known user", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({ id: "user-1" })
    mockDb.user.update.mockResolvedValueOnce({ id: "user-1", locale: "ur" })
    const user = await setUserLocale("user-1", "ur")
    expect(mockDb.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { locale: "ur" },
      select: { id: true, locale: true },
    })
    expect(user).toEqual({ id: "user-1", locale: "ur" })
  })
})

describe("awaitWithTimeout (I18N-308 race, shared helper)", () => {
  it("resolves with the value once the promise lands", async () => {
    await expect(
      awaitWithTimeout(Promise.resolve({ locale: "ur" }), 1000)
    ).resolves.toEqual({ locale: "ur" })
  })

  it("resolves undefined after the timeout when the promise hangs", async () => {
    await expect(
      awaitWithTimeout(new Promise(() => {}), 10)
    ).resolves.toBeUndefined()
  })

  it("rejects when the promise rejects first (the caller swallows it)", async () => {
    await expect(
      awaitWithTimeout(Promise.reject(new Error("offline")), 1000)
    ).rejects.toThrow("offline")
  })

  it("both persist hooks await through the helper and swallow failures", () => {
    for (const file of [
      "apps/dashboard/components/dashboard/use-persist-locale.ts",
      "apps/admin/components/admin/use-persist-locale.ts",
    ]) {
      const src = read(file)
      expect(src).toContain("export async function awaitPersistLocale(")
      expect(src).toContain(
        "await awaitWithTimeout(mutation.mutateAsync(locale), timeoutMs)"
      )
      expect(src).toContain("} catch {")
    }
  })
})

describe("stored-locale call sites (DSH-001 / DSH-201 / DSH-401 / I18N-203 / AIM-015 / I18N-311)", () => {
  it("no no-arg getRequestLocale() call remains in either app", () => {
    const offenders: string[] = []
    for (const dir of ["apps/dashboard", "apps/admin"]) {
      for (const file of walk(dir)) {
        if (read(file).includes("getRequestLocale()")) offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  it("both layouts resolve the shell locale with the session user id", () => {
    expect(read("apps/dashboard/app/layout.tsx")).toContain(
      "getRequestLocale(session?.user?.id)"
    )
    expect(read("apps/dashboard/app/dashboard/layout.tsx")).toContain(
      "getRequestLocale(session.user.id)"
    )
    expect(read("apps/admin/app/layout.tsx")).toContain(
      "getRequestLocale(session?.user?.id)"
    )
    expect(read("apps/admin/app/admin/layout.tsx")).toContain(
      "getRequestLocale(session.user.id)"
    )
  })

  it("the admin adapter mirrors the dashboard adapter's DB fallback", () => {
    const admin = read("apps/admin/lib/i18n.ts")
    expect(admin).toContain("getRequestLocale(userId?: string)")
    expect(admin).toContain("getUserLocale(userId)")
    expect(admin).toContain("isSelectableLocale")
  })

  it("every admin page passes the session user id", () => {
    const offenders: string[] = []
    for (const file of walk("apps/admin/app/admin")) {
      const src = read(file)
      if (
        src.includes("getRequestLocale(") &&
        !src.includes("getRequestLocale(session.user.id)") &&
        !src.includes("getRequestLocale(session?.user?.id)")
      ) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  it("the new-form page passes the session user id (I18N-311)", () => {
    expect(read("apps/dashboard/app/dashboard/forms/new/page.tsx")).toContain(
      "getRequestLocale(session.user.id)"
    )
  })
})

describe("language selector first paint (I18N-309 / DSH-007 / I18N-206)", () => {
  const selectors = [
    "apps/dashboard/components/dashboard/language-selector.tsx",
    "apps/admin/components/admin/language-selector.tsx",
  ]

  it.each(selectors)(
    "%s starts from the server-resolved locale and awaits the persist",
    (file) => {
      const src = read(file)
      expect(src).toContain("initialLocale")
      expect(src).toContain("useState<LocaleCode>(initialLocale)")
      expect(src).not.toContain('useState<LocaleCode>("en")')
      expect(src).toContain("awaitPersistLocale(persistLocale, locale)")
      expect(src).not.toContain("persistLocale.mutate(locale)")
    }
  )

  it("both sidebars hand the server locale to the selector", () => {
    for (const file of [
      "apps/dashboard/components/dashboard/app-sidebar.tsx",
      "apps/admin/components/admin/app-sidebar.tsx",
    ]) {
      expect(read(file)).toContain("initialLocale")
      expect(read(file)).toContain(
        "<LanguageSelector side={side} initialLocale={initialLocale} />"
      )
    }
    expect(read("apps/dashboard/app/dashboard/layout.tsx")).toContain(
      "initialLocale={locale}"
    )
    expect(read("apps/admin/app/admin/layout.tsx")).toContain(
      "initialLocale={locale}"
    )
  })

  it("the admin language prompt awaits the persist before reloading", () => {
    const src = read("apps/admin/components/admin/language-prompt.tsx")
    expect(src).toContain("awaitPersistLocale(persistLocale, locale)")
  })
})

describe("account forms (DSH-002)", () => {
  it.each([
    "apps/dashboard/app/dashboard/account/update-name-form.tsx",
    "apps/dashboard/app/dashboard/account/change-email-form.tsx",
    "apps/dashboard/app/dashboard/account/change-password-form.tsx",
  ])(
    "%s disables native validation so the translated errors can fire",
    (file) => {
      expect(read(file)).toContain("noValidate")
      // `required` stays for semantics/accessibility; noValidate is
      // what lets the translated Zod messages run for empty input.
      expect(read(file)).toContain("required")
    }
  )
})
