import { redirect } from "next/navigation"

// All users rename (Phase A, plan §3.2): the users list moved to
// /admin/all-users. This thin page keeps every old deep link working —
// including filtered-list bookmarks, so the query string is carried
// over unchanged.
export default async function AdminUsersRedirect({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const raw = await searchParams
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") qs.set(key, value)
    else if (Array.isArray(value))
      for (const item of value) qs.append(key, item)
  }
  redirect(`/admin/all-users${qs.size > 0 ? `?${qs.toString()}` : ""}`)
}
