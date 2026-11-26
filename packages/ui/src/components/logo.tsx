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

// The shipped brand logo is 208x50 in every app's config.json —
// the fallback when a brand's configured dimensions are not usable
// numbers (SRC-328(d)): Number("abc") is NaN, and NaN widths make
// next/image throw, so garbage config must degrade to the default
// size instead of erroring the page.
const DEFAULT_LOGO_WIDTH = 208
const DEFAULT_LOGO_HEIGHT = 50

function toFiniteDimension(value: string | number, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function Logo({ brand, className, variant = "auto" }: Props) {
  const width = toFiniteDimension(brand.logo_width, DEFAULT_LOGO_WIDTH)
  const height = toFiniteDimension(brand.logo_height, DEFAULT_LOGO_HEIGHT)

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
            "inline-block h-auto max-w-40",
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
            "inline-block h-auto max-w-40",
            variant === "auto" ? "hidden dark:block" : "block"
          )}
          priority
        />
      )}
    </span>
  )
}
