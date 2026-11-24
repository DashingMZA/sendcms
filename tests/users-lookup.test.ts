// lookupUserByEmail (SRC-228): trims the input and never confirms
// or denies existence per probe. Mocked Prisma client, same pattern
// as domain-service.test.ts.
import { describe, expect, it, vi } from "vitest"

const mockDb = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
}))
vi.mock("@sendcms/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sendcms/database")>()
  return { ...actual, db: mockDb }
})

import { lookupUserByEmail } from "@sendcms/users"

describe("lookupUserByEmail (SRC-228)", () => {
  it("trims surrounding whitespace before lookup", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce({
      id: "user-1",
      name: "User One",
      email: "user1@example.com",
    })
    const user = await lookupUserByEmail("  User1@Example.com  ")
    expect(mockDb.user.findUnique).toHaveBeenCalledWith({
      where: { email: "user1@example.com" },
    })
    expect(user.id).toBe("user-1")
  })

  it("throws a generic not-found error that does not name the probed email", async () => {
    mockDb.user.findUnique.mockResolvedValueOnce(null)
    const error = await lookupUserByEmail("nobody@example.com").catch(
      (err: unknown) => err
    )
    expect(error).toMatchObject({ status: 404 })
    expect((error as Error).message).toBe("User not found")
    expect((error as Error).message).not.toContain("nobody@example.com")
  })
})
