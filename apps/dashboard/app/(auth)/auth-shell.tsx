import Link from "next/link"
import config from "@/config/config.json"
import { Logo } from "@sendcms/ui"
import { SignInPanel } from "./sign-in/sign-in-panel"

/**
 * Shared two-column layout for the (auth) pages: brand panel on the left,
 * form on the right. Same structure the sign-in page always had.
 */
export function AuthShell({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <div className="grid min-h-svh lg:grid-cols-2">
      {/* Left — brand panel */}
      <SignInPanel />
      {/* Right — form */}
      <div className="flex flex-col items-center justify-center px-6 py-16">
        {/* Mobile logo */}
        <Link href="/" className="mb-10 flex items-center lg:hidden">
          <Logo brand={config.site} />
        </Link>

        <div className="w-full max-w-90 space-y-8">
          <div className="space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight text-pretty">
              {title}
            </h1>
            <p className="text-sm text-muted-foreground">{description}</p>
          </div>

          {children}
        </div>
      </div>
    </div>
  )
}
