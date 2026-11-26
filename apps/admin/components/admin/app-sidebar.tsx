"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { authClient } from "@sendcms/auth/client"

import { useTheme } from "next-themes"
import config from "@/config/config.json"
import { dashboardSignInURL, dashboardURL } from "@/lib/callback-url"
import { Logo } from "@sendcms/ui"
import {
  RiBarChartLine,
  RiBookLine,
  RiBrainLine,
  RiCustomerServiceLine,
  RiDashboardLine,
  RiExpandUpDownLine,
  RiFileListLine,
  RiFileTextLine,
  RiFlagLine,
  RiGlobeLine,
  RiHistoryLine,
  RiInboxLine,
  RiKeyLine,
  RiLineChartLine,
  RiLogoutBoxLine,
  RiMegaphoneLine,
  RiMoonLine,
  RiPlugLine,
  RiPriceTag3Line,
  RiPulseLine,
  RiRepeatLine,
  RiRobotLine,
  RiSettings3Line,
  RiShieldLine,
  RiSunLine,
  RiTimerLine,
  RiToolsLine,
  RiUserLine,
  RiWalletLine,
} from "@remixicon/react"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@sendcms/ui"
import { LanguageSelector } from "@/components/admin/language-selector"
import { useTranslation } from "@/components/admin/translation-provider"
import { getActiveNavHref } from "@/components/admin/nav-active"
import type { AdminRole, PlatformRole } from "@sendcms/permissions"
import type { LocaleCode } from "@/lib/i18n-client"

type NavItem = {
  label: string
  href: string
  icon: React.ElementType
  // DOC-053: external docs link — opens in a new tab, never matched
  // as the active route.
  external?: boolean
  /** Count badge shown on the item (DSH-406: new-ticket count on
      Support). Rendered only when greater than 0. */
  badge?: number
}

type NavGroup = {
  label: string
  items: NavItem[]
}

type Props = {
  user: {
    name?: string | null
    email?: string | null
    image?: string | null
    adminRole?: AdminRole | null
    platformRole?: PlatformRole
  }
  /** Which side the sidebar sits on: "left" in LTR, "right" in RTL.
   * The shadcn Sidebar pins itself physically (left-0 / right-0), so
   * this must come from the locale direction — dir="rtl" alone does
   * not move it. Passed from the server layout (language switching
   * reloads the page, so it is never stale). */
  side: "left" | "right"
  /**
   * Server-resolved locale, handed to the language selector so its
   * first paint names the active language (I18N-206 / I18N-309).
   * Without it the selector SSR-rendered "English" on every Urdu
   * page and only corrected after hydration.
   */
  initialLocale?: LocaleCode
  /** DSH-406 (owner decision 2026-11-25, option (b)): the number of
      new (OPEN) support tickets, shown as a badge on the Support nav
      item — staff learn of new tickets in the shell, NOT by
      email/notification. 0 (or absent) renders no badge. */
  newTicketCount?: number
  /** Wave 10, UX-013: the number of pending (REQUESTED) deletion
      requests, shown as a badge on the Security nav item. 0 (or
      absent) renders no badge. */
  pendingDeletionCount?: number
}

export function AppSidebar({
  user,
  side,
  initialLocale,
  newTicketCount = 0,
  pendingDeletionCount = 0,
}: Props) {
  const { t } = useTranslation("navigation")
  const { t: tDashboard } = useTranslation("dashboard")
  const { t: tCommon } = useTranslation("common")
  const { t: tUsers } = useTranslation("users")
  const navGroups: NavGroup[] = [
    {
      label: t("platform"),
      items: [
        { label: t("overview"), href: "/admin", icon: RiDashboardLine },
        { label: t("allUsers"), href: "/admin/all-users", icon: RiUserLine },
        {
          label: t("plans"),
          href: "/admin/plans",
          icon: RiPriceTag3Line,
        },
        {
          label: t("plansAndSubscriptions"),
          href: "/admin/plans-subscriptions",
          icon: RiPriceTag3Line,
        },
        {
          label: t("subscriptions"),
          href: "/admin/subscriptions",
          icon: RiRepeatLine,
        },
        {
          label: t("trials"),
          href: "/admin/trials",
          icon: RiTimerLine,
        },
        {
          label: t("usage"),
          href: "/admin/usage",
          icon: RiBarChartLine,
        },
        {
          label: t("billing"),
          href: "/admin/billing",
          icon: RiWalletLine,
        },
        {
          label: t("payments"),
          href: "/admin/payments",
          icon: RiWalletLine,
        },
        {
          label: t("submissions"),
          href: "/admin/submissions",
          icon: RiInboxLine,
        },
      ],
    },
    {
      label: t("ai"),
      items: [
        { label: t("aiOverview"), href: "/admin/ai", icon: RiRobotLine },
        {
          label: t("aiProviders"),
          href: "/admin/ai/providers",
          icon: RiBrainLine,
        },
        {
          label: t("aiModels"),
          href: "/admin/ai/models",
          icon: RiFileListLine,
        },
        {
          label: t("aiUsage"),
          href: "/admin/ai/usage",
          icon: RiLineChartLine,
        },
        {
          label: t("aiSettings"),
          href: "/admin/ai/settings",
          icon: RiToolsLine,
        },
      ],
    },
    {
      label: t("integrations"),
      items: [
        { label: t("mcp"), href: "/admin/mcp", icon: RiPlugLine },
        {
          label: t("mcpKeys"),
          href: "/admin/mcp/keys",
          icon: RiKeyLine,
        },
      ],
    },
    {
      label: t("operations"),
      items: [
        {
          label: t("features"),
          href: "/admin/features",
          icon: RiFlagLine,
        },
        {
          label: t("announcements"),
          href: "/admin/announcements",
          icon: RiMegaphoneLine,
        },
        {
          label: t("activity"),
          href: "/admin/activity",
          icon: RiHistoryLine,
        },
        {
          label: t("auditLogs"),
          href: "/admin/audit-logs",
          icon: RiFileTextLine,
        },
        {
          label: t("support"),
          href: "/admin/support",
          icon: RiCustomerServiceLine,
          badge: newTicketCount,
        },
      ],
    },
    {
      label: t("system"),
      items: [
        {
          label: t("health"),
          href: "/admin/health",
          icon: RiPulseLine,
        },
        {
          label: t("security"),
          href: "/admin/security",
          icon: RiShieldLine,
          badge: pendingDeletionCount,
        },
        {
          label: t("translations"),
          href: "/admin/translations",
          icon: RiGlobeLine,
        },
        {
          label: t("settings"),
          href: "/admin/settings",
          icon: RiSettings3Line,
        },
        // DOC-053: the admin control-plane docs (22 files under
        // docs/admin-control-plane/) — GitHub until a docs-app route
        // exists. External: new tab, never the active route.
        {
          label: t("docs"),
          href: "https://github.com/DashingMZA/sendcms/blob/feature/admin-control-plane/docs/admin-control-plane/README.md",
          icon: RiBookLine,
          external: true,
        },
      ],
    },
  ]

  const pathname = usePathname()
  const { resolvedTheme, setTheme } = useTheme()
  // Collapsed-icon tooltips sit on the sidebar's OUTER side: right
  // when the sidebar is on the left, left when it is on the right.
  const tooltipSide = side === "right" ? "left" : "right"
  const initials = (user.name ?? user.email ?? "U")
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase()
  // UX-016: the role the admin is acting as (staff role first, then
  // the platform role) — capabilities differ sharply by role, so the
  // shell names it at a glance.
  const roleLabel =
    user.adminRole === "SUPER_ADMIN"
      ? tUsers("roleSuperAdmin")
      : user.adminRole === "MANAGER"
        ? tUsers("roleManager")
        : user.adminRole === "SUPPORT"
          ? tUsers("roleSupport")
          : user.platformRole === "PLATFORM_OWNER"
            ? tUsers("platformOwner")
            : tUsers("platformUser")
  // UX-002 / UX-305: exactly one active item — the longest href that
  // matches on a segment boundary (see nav-active.ts).
  const activeHref = getActiveNavHref(
    navGroups.flatMap((group) =>
      group.items
        .filter((item) => item.external !== true)
        .map((item) => item.href)
    ),
    pathname
  )

  return (
    <Sidebar collapsible="icon" side={side}>
      {/* ── Header ──────────────────────────────────────── */}
      <SidebarHeader className="mb-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              className="flex items-center p-0 hover:bg-transparent"
            >
              {/* UX-014: in collapsed (icon) mode the button is 32 px
                  wide with overflow hidden — the 160 px wordmark
                  would show as a clipped slice. Hide the wordmark
                  and show a compact brand mark instead. */}
              <Link
                href="/admin"
                className="max-h-[42px] ps-0 group-data-[collapsible=icon]:hidden"
              >
                <Logo brand={config.site} />
              </Link>
              <Link
                href="/admin"
                aria-label={config.site.title}
                className="hidden size-8 items-center justify-center rounded-md bg-primary text-base font-bold text-primary-foreground group-data-[collapsible=icon]:flex"
              >
                {config.site.logo_text.charAt(0)}
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      {/* ── Content ─────────────────────────────────────── */}
      <SidebarContent>
        {navGroups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-1">
                {group.items.map((item) => {
                  const active =
                    item.external === true ? false : item.href === activeHref
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild
                        isActive={active}
                        tooltip={{ children: item.label, side: tooltipSide }}
                      >
                        {item.external === true ? (
                          <a href={item.href} target="_blank" rel="noreferrer">
                            <item.icon aria-hidden="true" />
                            <span className="truncate">{item.label}</span>
                          </a>
                        ) : (
                          <Link href={item.href}>
                            <item.icon aria-hidden="true" />
                            <span className="truncate">{item.label}</span>
                            {item.badge !== undefined && item.badge > 0 && (
                              <SidebarMenuBadge>{item.badge}</SidebarMenuBadge>
                            )}
                          </Link>
                        )}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      {/* ── Footer / user ───────────────────────────────── */}
      <SidebarFooter>
        <SidebarMenu className="gap-1">
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={{
                children:
                  resolvedTheme === "dark"
                    ? tDashboard("darkMode")
                    : tDashboard("lightMode"),
                side: tooltipSide,
              }}
              onClick={() =>
                setTheme(resolvedTheme === "dark" ? "light" : "dark")
              }
            >
              {resolvedTheme === "dark" ? (
                <RiMoonLine className="size-4 shrink-0" aria-hidden="true" />
              ) : (
                <RiSunLine className="size-4 shrink-0" aria-hidden="true" />
              )}
              <span className="group-data-[collapsible=icon]:hidden">
                {resolvedTheme === "dark"
                  ? tDashboard("darkMode")
                  : tDashboard("lightMode")}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <LanguageSelector side={side} initialLocale={initialLocale} />
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                >
                  <Avatar className="size-7 shrink-0">
                    <AvatarImage
                      src={user.image ?? undefined}
                      alt={user.name ?? ""}
                    />
                    <AvatarFallback className="bg-sidebar-primary/10 text-xs font-semibold text-sidebar-primary">
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 overflow-hidden text-start leading-tight group-data-[collapsible=icon]:hidden">
                    <p className="truncate text-sm font-semibold">
                      {user.name}
                    </p>
                    <p className="truncate text-xs text-sidebar-foreground/70">
                      {user.email}
                    </p>
                    <Badge variant="secondary" className="mt-1">
                      {roleLabel}
                    </Badge>
                  </div>
                  <RiExpandUpDownLine
                    className="ms-auto size-4 text-sidebar-foreground/50 group-data-[collapsible=icon]:hidden"
                    aria-hidden="true"
                  />
                </SidebarMenuButton>
              </DropdownMenuTrigger>

              <DropdownMenuContent
                side="top"
                align="start"
                sideOffset={4}
                className="w-56"
              >
                <DropdownMenuLabel className="py-2 font-normal">
                  <p className="truncate text-sm font-semibold">{user.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {user.email}
                  </p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild className="cursor-pointer">
                  <Link href={dashboardURL()}>
                    <RiDashboardLine className="size-4" aria-hidden="true" />
                    {t("goToDashboard")}
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() =>
                    authClient.signOut({
                      fetchOptions: {
                        onSuccess: () => {
                          window.location.href = dashboardSignInURL()
                        },
                      },
                    })
                  }
                  className="cursor-pointer"
                >
                  <RiLogoutBoxLine className="size-4" aria-hidden="true" />
                  {tCommon("signOut")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail label={t("toggleSidebar")} />
    </Sidebar>
  )
}
