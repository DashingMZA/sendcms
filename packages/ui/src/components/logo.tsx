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

  // PRF-008 (Phase 16, Wave 11): the logo displays at most 160px
  // wide (`max-w-40` below), but next/image was serving a 640w
  // smallest candidate (default deviceSizes) with a 1080w `src`
  // fallback. When no `sizes` prop is given, Next builds the srcset
  // from the `width` prop as [width, width*2] mapped onto
  // imageSizes + deviceSizes — so pass the DISPLAY size (capped at
  // the 160px CSS cap, aspect preserved): the srcset becomes
  // 160w 1x / 320w 2x and the `src` fallback is the 320w file.
  // (The first attempt passed a sizes prop of 160px instead — verified
  // against Next 16's getWidths, a `sizes` without vw percentages
  // enumerates EVERY configured width in the srcset and sets the
  // fallback to the largest, 3840w. Do not re-add it.)
  // `imageSizes: [160, 320]` in each app's next.config is what makes
  // 160/320 available as candidates.
  const DISPLAY_WIDTH = 160 // must match the max-w-40 cap below
  const displayWidth = Math.min(width, DISPLAY_WIDTH)
  const displayHeight = Math.max(1, Math.round((displayWidth * height) / width))
  const displaySize = { width: displayWidth, height: displayHeight }
  // Preload (PRF-008, second half): both theme variants used to carry
  // `priority`, so every page preloaded one logo it never displays.
  // Exactly one variant is preloaded now — the light one in `auto`
  // mode (the default/first-paint variant) and the dark one when the
  // variant is pinned to `dark` (e.g. the sign-in brand panel). The
  // other variant still renders (the CSS `dark:` switch must stay
  // instant) but without a preload link; a theme toggle loads it on
  // demand. True per-resolved-theme preload would need the server to
  // know the theme (e.g. a theme cookie) — the server cannot, so the
  // light-first-paint default is the honest approximation.
  // PRF-008 priorities, computed BEFORE the `{variant !== "dark"}`
  // guards below narrow the type (a comparison inside the narrowed
  // branch would be flagged as unintentional by TS).
  const lightPriority = variant !== "dark"
  const darkPriority = variant === "dark"

  return (
    <span className={cn("inline-flex items-center", className)}>
      {variant !== "dark" && (
        <Image
          src={brand.logo}
          alt={brand.logo_text}
          {...displaySize}
          className={cn(
            "inline-block h-auto max-w-40",
            variant === "auto" && "dark:hidden"
          )}
          priority={lightPriority}
        />
      )}
      {variant !== "light" && (
        <Image
          src={brand.logo_darkmode}
          alt={brand.logo_text}
          {...displaySize}
          className={cn(
            "inline-block h-auto max-w-40",
            variant === "auto" ? "hidden dark:block" : "block"
          )}
          priority={darkPriority}
        />
      )}
    </span>
  )
}
