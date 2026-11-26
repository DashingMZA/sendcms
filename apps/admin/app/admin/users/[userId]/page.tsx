import { redirect } from "next/navigation"

// All users rename (Phase A, plan §3.2): the user-detail route moved
// to /admin/all-users/[userId] with the list. This thin page keeps
// every old detail deep link working.
export default async function AdminUsersUserRedirect({
  params,
}: {
  params: Promise<{ userId: string }>
}) {
  const { userId } = await params
  redirect(`/admin/all-users/${userId}`)
}
