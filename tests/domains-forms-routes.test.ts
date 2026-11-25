// DSH-107: domains/forms list routes — the paged shape when query
// params are present, the bare array with none, and 422 for unknown
// or invalid params (strict schema) instead of silently dropping them.
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockAuth = vi.hoisted(() => vi.fn())
vi.mock("@/lib/auth", () => ({ auth: mockAuth }))

const mockListDomainsForUser = vi.hoisted(() => vi.fn())
const mockListDomainsPageForUser = vi.hoisted(() => vi.fn())
vi.mock("@sendcms/domains", () => ({
  listDomainsForUser: mockListDomainsForUser,
  listDomainsPageForUser: mockListDomainsPageForUser,
  createDomainForUser: vi.fn(),
}))

const mockListFormsForUser = vi.hoisted(() => vi.fn())
const mockListFormsPageForUser = vi.hoisted(() => vi.fn())
vi.mock("@sendcms/forms", () => ({
  listFormsForUser: mockListFormsForUser,
  listFormsPageForUser: mockListFormsPageForUser,
  createFormForUser: vi.fn(),
}))

import { NextRequest } from "next/server"
import { GET as getDomains } from "../apps/api/app/api/v1/domains/route"
import { GET as getForms } from "../apps/api/app/api/v1/forms/route"

const DOMAINS_URL = "http://localhost:3001/api/v1/domains"
const FORMS_URL = "http://localhost:3001/api/v1/forms"

const domainRow = (id: string) => ({
  id,
  domain: `${id}.example.com`,
  status: "VERIFIED",
  verifiedAt: new Date("2026-11-20T10:00:00Z"),
  createdAt: new Date("2026-11-20T10:00:00Z"),
  verifications: [],
  _count: { formLinks: 1 },
})

const formRow = (id: string) => ({
  id,
  name: `Form ${id}`,
  active: true,
  createdAt: new Date("2026-11-20T10:00:00Z"),
  _count: { fields: 3, domainLinks: 1, submissions: 0 },
})

beforeEach(() => {
  vi.clearAllMocks()
  mockAuth.mockResolvedValue({ user: { id: "user-1" } })
  mockListDomainsForUser.mockResolvedValue([domainRow("d1"), domainRow("d2")])
  mockListFormsForUser.mockResolvedValue([formRow("f1"), formRow("f2")])
  mockListDomainsPageForUser.mockResolvedValue({
    items: [domainRow("d1")],
    total: 2,
    page: 1,
    perPage: 1,
  })
  mockListFormsPageForUser.mockResolvedValue({
    items: [formRow("f1")],
    total: 2,
    page: 1,
    perPage: 1,
  })
})

describe("GET /api/v1/domains (DSH-107)", () => {
  it("returns the bare array with no query params (back-compat)", async () => {
    const res = await getDomains(new NextRequest(DOMAINS_URL))
    expect(res.status).toBe(200)
    expect(await res.json()).toHaveLength(2)
    expect(mockListDomainsForUser).toHaveBeenCalledWith("user-1")
    expect(mockListDomainsPageForUser).not.toHaveBeenCalled()
  })

  it("returns 1 row for ?limit=1 on an account with 2 domains", async () => {
    const res = await getDomains(new NextRequest(`${DOMAINS_URL}?limit=1`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(1)
    expect(body.total).toBe(2)
    expect(body.page).toBe(1)
    expect(body.perPage).toBe(1)
    expect(mockListDomainsPageForUser).toHaveBeenCalledWith("user-1", {
      search: undefined,
      page: 1,
      perPage: 1,
      sortBy: "createdAt",
      sortDir: "desc",
    })
  })

  it("honours search + page from the finding's repro (?search=audit5&limit=1&page=2)", async () => {
    mockListDomainsPageForUser.mockResolvedValue({
      items: [domainRow("d2")],
      total: 2,
      page: 2,
      perPage: 1,
    })
    const res = await getDomains(
      new NextRequest(`${DOMAINS_URL}?search=audit5&limit=1&page=2`)
    )
    expect(res.status).toBe(200)
    expect((await res.json()).items).toHaveLength(1)
    expect(mockListDomainsPageForUser).toHaveBeenCalledWith("user-1", {
      search: "audit5",
      page: 2,
      perPage: 1,
      sortBy: "createdAt",
      sortDir: "desc",
    })
  })

  it("422s an invalid page instead of silently dropping it", async () => {
    const res = await getDomains(new NextRequest(`${DOMAINS_URL}?page=abc`))
    expect(res.status).toBe(422)
    expect(mockListDomainsPageForUser).not.toHaveBeenCalled()
  })

  it("422s an unknown param instead of silently dropping it", async () => {
    const res = await getDomains(new NextRequest(`${DOMAINS_URL}?bogus=1`))
    expect(res.status).toBe(422)
    expect(mockListDomainsPageForUser).not.toHaveBeenCalled()
  })

  it("401s with no session", async () => {
    mockAuth.mockResolvedValueOnce(null)
    const res = await getDomains(new NextRequest(DOMAINS_URL))
    expect(res.status).toBe(401)
  })
})

describe("GET /api/v1/forms (DSH-107)", () => {
  it("returns the bare array with no query params (back-compat)", async () => {
    const res = await getForms(new NextRequest(FORMS_URL))
    expect(res.status).toBe(200)
    expect(await res.json()).toHaveLength(2)
    expect(mockListFormsForUser).toHaveBeenCalledWith("user-1")
    expect(mockListFormsPageForUser).not.toHaveBeenCalled()
  })

  it("returns 1 row for ?limit=1 on an account with 2 forms", async () => {
    const res = await getForms(new NextRequest(`${FORMS_URL}?limit=1`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(1)
    expect(body.total).toBe(2)
    expect(mockListFormsPageForUser).toHaveBeenCalledWith("user-1", {
      search: undefined,
      page: 1,
      perPage: 1,
      sortBy: "createdAt",
      sortDir: "desc",
    })
  })

  it("422s an unknown param instead of silently dropping it", async () => {
    const res = await getForms(new NextRequest(`${FORMS_URL}?bogus=1`))
    expect(res.status).toBe(422)
  })
})
