import type { Metadata } from "next"
import Link from "next/link"
import { Button, Logo } from "@sendcms/ui"
import config from "@/config/config.json"
import { auth } from "@/lib/auth"

export const metadata: Metadata = {
  title: "SendCMS Dashboard",
  description:
    "Sign in to manage your SendCMS domains, forms, and submissions.",
}

// Root landing page: the dashboard app has no public homepage, so a
// direct visit lands here instead of a 404. Signed-out visitors get a
// sign-in button; signed-in users get a button to the overview.
export default async function HomePage() {
  const session = await auth()
  return (
    <main
      id="main-content"
      className="flex min-h-svh flex-col items-center justify-center px-4 py-16 text-center"
    >
      <Logo brand={config.site} className="mb-6" />
      <h1 className="mb-3 text-2xl font-bold tracking-tight">
        SendCMS Dashboard
      </h1>
      <p className="mb-8 max-w-md leading-relaxed text-muted-foreground">
        Manage your domains, forms, and submissions — view the inbox, check
        analytics, and get the embed snippet.
      </p>
      {session ? (
        <Button asChild>
          <Link href="/dashboard">Go to dashboard</Link>
        </Button>
      ) : (
        <Button asChild>
          <Link href="/sign-in">Sign in</Link>
        </Button>
      )}
    </main>
  )
}
