"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { authClient } from "@sendcms/auth/client"

import { useTheme } from "next-themes"
import config from "@/config/config.json"
import { docsUrl } from "@/lib/app-links"
import { Logo } from "@sendcms/ui"
import { resolveActiveHref } from "@/lib/nav-active"
import { useTranslation } from "@/components/dashboard/translation-provider"
import { LanguageSelector } from "@/components/dashboard/language-selector"
import type { LocaleCode } from "@/lib/i18n-client"
import {
  RiDashboardLine,
  RiLinksLine,
  RiFileListLine,
  RiInboxLine,
  RiNotificationLine,
  RiBarChartLine,
  RiCodeSSlashLine,
  RiKeyLine,
  RiRobotLine,
  RiCustomerServiceLine,
  RiLogoutBoxLine,
  RiExpandUpDownLine,
  RiAddLine,
  RiSunLine,
  RiMoonLine,
  RiUserLine,
  RiWalletLine,
  RiBookOpenLine,
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
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@sendcms/ui"

type NavItem = {
  label: string
  href: string
  icon: React.ElementType
  badge?: number
}

type NavGroup = {
  label: string
  items: NavItem[]
}

type Props = {
  user: { name?: string | null; email?: string | null; image?: string | null }
  domainCount: number
  formCount: number
  inboxCount: number
  /** Which side the sidebar sits on: "left" in LTR, "right" in RTL. */
  side: "left" | "right"
  /**
   * Server-resolved locale, handed to the language selector so its
   * first paint names the active language (I18N-309 / DSH-007).
   * Without it the selector SSR-rendered "English" on every Urdu
   * page and only corrected after hydration.
   */
  initialLocale?: LocaleCode
}

export function AppSidebar({
  user,
  domainCount,
  formCount,
  inboxCount,
  side,
  initialLocale,
}: Props) {
  const router = useRouter()
  const { t } = useTranslation("navigation")
  const navGroups: NavGroup[] = [
    {
      label: t("groupApplication"),
      items: [
        { label: t("overview"), href: "/dashboard", icon: RiDashboardLine },
        {
          label: t("domains"),
          href: "/dashboard/domains",
          icon: RiLinksLine,
          badge: domainCount,
        },
        {
          label: t("forms"),
          href: "/dashboard/forms",
          icon: RiFileListLine,
          badge: formCount,
        },
        {
          label: t("inbox"),
          href: "/dashboard/inbox",
          icon: RiInboxLine,
          badge: inboxCount,
        },
        {
          label: t("notifications"),
          href: "/dashboard/notifications",
          icon: RiNotificationLine,
        },
        {
          label: t("analytics"),
          href: "/dashboard/analytics",
          icon: RiBarChartLine,
        },
        {
          label: t("apiSdk"),
          href: "/dashboard/api",
          icon: RiCodeSSlashLine,
        },
        {
          label: t("apiKeys"),
          href: "/dashboard/api-keys",
          icon: RiKeyLine,
        },
        {
          label: t("ai"),
          href: "/dashboard/ai",
          icon: RiRobotLine,
        },
        {
          label: t("support"),
          href: "/dashboard/support",
          icon: RiCustomerServiceLine,
        },
      ],
    },
    {
      label: t("groupMyAccount"),
      items: [
        { label: t("profile"), href: "/dashboard/account", icon: RiUserLine },
        {
          label: t("billing"),
          href: "/dashboard/billing",
          icon: RiWalletLine,
        },
      ],
    },
  ]

  const pathname = usePathname()
  // UX-305: one active item — the longest href matching on a segment
  // boundary (so /dashboard/api-keys does not also light /dashboard/api).
  const activeHref = resolveActiveHref(
    pathname,
    navGroups.flatMap((group) => group.items.map((item) => item.href))
  )
  const { resolvedTheme, setTheme } = useTheme()
  const themeLabel = resolvedTheme === "dark" ? t("darkMode") : t("lightMode")
  // Collapsed-icon tooltips sit on the sidebar's OUTER side: right
  // when the sidebar is on the left, left when it is on the right.
  const tooltipSide = side === "right" ? "left" : "right"
  const initials = (user.name ?? user.email ?? "U")
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase()

  return (
    <Sidebar collapsible="icon" side={side}>
      {/* ── Header ──────────────────────────────────────── */}
      <SidebarHeader className="mb-0">
        <SidebarMenu>
          <SidebarMenuItem>
            {/* UX-014: in icon mode the wordmark hides and a compact
                "S" tile takes its place. */}
            <SidebarMenuButton
              size="lg"
              className="flex items-center p-0 group-data-[collapsible=icon]:hidden hover:bg-transparent"
            >
              <Link href="/dashboard" className="max-h-[42px] ps-0">
                <Logo brand={config.site} />
              </Link>
            </SidebarMenuButton>
            <Link
              href="/dashboard"
              aria-label={t("overview")}
              className="mx-auto hidden size-8 items-center justify-center rounded-lg bg-primary text-base font-bold text-primary-foreground group-data-[collapsible=icon]:flex"
            >
              S
            </Link>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      {/* ── Content ─────────────────────────────────────── */}
      <SidebarContent>
        {/* New form shortcut */}
        <SidebarGroup>
          <SidebarGroupContent className="group-data-[collapsible=icon]:px-0">
            <SidebarMenu className="group-data-[collapsible=icon]:items-center">
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  tooltip={t("newForm")}
                  className="border-2 border-dashed border-primary/40 bg-primary/5 py-5 text-primary/70 transition-colors duration-200 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:py-2 group-data-[collapsible=icon]:text-sidebar-foreground hover:bg-primary/10 hover:text-primary group-data-[collapsible=icon]:hover:bg-primary/10 group-data-[collapsible=icon]:hover:text-primary"
                >
                  <Link href="/dashboard/forms/new">
                    <RiAddLine className="size-4 shrink-0" aria-hidden="true" />
                    <span className="text-sm font-medium group-data-[collapsible=icon]:hidden">
                      {t("newForm")}
                    </span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Nav */}
        {navGroups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-1">
                {group.items.map((item) => {
                  const active = item.href === activeHref
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild
                        isActive={active}
                        tooltip={{ children: item.label, side: tooltipSide }}
                      >
                        <Link href={item.href}>
                          <item.icon aria-hidden="true" />
                          <span className="truncate">{item.label}</span>
                          {item.badge !== undefined && (
                            <Badge
                              variant="secondary"
                              className="ms-auto me-1 group-data-[collapsible=icon]:hidden"
                            >
                              {item.badge}
                            </Badge>
                          )}
                        </Link>
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
          {/* DSH-006: the dashboard's help/docs link — the docs site
              lives on its own origin (NEXT_PUBLIC_DOCS_URL), so this
              is an absolute external link, opened in a new tab. */}
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              tooltip={{ children: t("docs"), side: tooltipSide }}
            >
              <Link href={docsUrl()} target="_blank" rel="noopener noreferrer">
                <RiBookOpenLine
                  className="size-4 shrink-0"
                  aria-hidden="true"
                />
                <span className="group-data-[collapsible=icon]:hidden">
                  {t("docs")}
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={{
                children: themeLabel,
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
                {themeLabel}
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
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() =>
                    authClient.signOut({
                      fetchOptions: {
                        onSuccess: () => {
                          router.push("/sign-in")
                        },
                      },
                    })
                  }
                  className="cursor-pointer"
                >
                  <RiLogoutBoxLine className="size-4" aria-hidden="true" />
                  {t("signOut")}
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
