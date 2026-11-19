import Image from "next/image"
import { cn } from "@sendcms/shared"

// Brand values for the logo. The component takes them as a prop (it used
// to read them from the app's config.json) so it can live in the shared
// UI package: each app passes its own config's `site` object, which
// carries exactly these fields (plus favicon, which the logo ignores).
export type LogoBrand = {
  logo: string
  logo_darkmode: string
  logo_width: string | number
  logo_height: string | number
  logo_text: string
}

type Props = {
  brand: LogoBrand
  className?: string
  // "auto" follows the site theme; "light"/"dark" pin a variant for
  // surfaces (e.g. the sign-in brand panel) that ignore the site theme.
  variant?: "auto" | "light" | "dark"
}

export function Logo({ brand, className, variant = "auto" }: Props) {
  const width = Number(brand.logo_width)
  const height = Number(brand.logo_height)

  // Request the image at 2x its display size — sharper on high-DPI screens
  // without relying on the (smaller) automatic srcSet breakpoints.
  const sourceSize = { width: width * 2, height: height * 2 }

  return (
    <span className={cn("inline-flex items-center", className)}>
      {variant !== "dark" && (
        <Image
          src={brand.logo}
          alt={brand.logo_text}
          {...sourceSize}
          className={cn(
            "inline-block h-auto max-w-[160px]",
            variant === "auto" && "dark:hidden"
          )}
          priority
        />
      )}
      {variant !== "light" && (
        <Image
          src={brand.logo_darkmode}
          alt={brand.logo_text}
          {...sourceSize}
          className={cn(
            "inline-block h-auto max-w-[160px]",
            variant === "auto" ? "hidden dark:block" : "block"
          )}
          priority
        />
      )}
    </span>
  )
}
