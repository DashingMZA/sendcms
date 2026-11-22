"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { authClient } from "@sendcms/auth/client"

import { useTheme } from "next-themes"
import config from "@/config/config.json"
import { dashboardSignInURL } from "@/lib/callback-url"
import { Logo } from "@sendcms/ui"
import {
  RiBarChartLine,
  RiBrainLine,
  RiDashboardLine,
  RiExpandUpDownLine,
  RiFileListLine,
  RiHistoryLine,
  RiKeyLine,
  RiLogoutBoxLine,
  RiMoonLine,
  RiPlugLine,
  RiPriceTag3Line,
  RiRepeatLine,
  RiRobotLine,
  RiSettings3Line,
  RiSunLine,
  RiUserLine,
} from "@remixicon/react"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
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
import { LanguageSelector } from "@/components/admin/language-selector"
import { useTranslation } from "@/components/admin/translation-provider"

type NavItem = {
  label: string
  href: string
  icon: React.ElementType
}

type NavGroup = {
  label: string
  items: NavItem[]
}

type Props = {
  user: { name?: string | null; email?: string | null; image?: string | null }
}

export function AppSidebar({ user }: Props) {
  const { t } = useTranslation("navigation")
  const { t: tDashboard } = useTranslation("dashboard")
  const { t: tCommon } = useTranslation("common")
  const navGroups: NavGroup[] = [
    {
      label: t("platform"),
      items: [
        { label: t("overview"), href: "/admin", icon: RiDashboardLine },
        { label: t("users"), href: "/admin/users", icon: RiUserLine },
        {
          label: t("plans"),
          href: "/admin/plans",
          icon: RiPriceTag3Line,
        },
        {
          label: t("subscriptions"),
          href: "/admin/subscriptions",
          icon: RiRepeatLine,
        },
        {
          label: t("usage"),
          href: "/admin/usage",
          icon: RiBarChartLine,
        },
      ],
    },
    {
      label: t("ai"),
      items: [
        { label: t("ai"), href: "/admin/ai", icon: RiRobotLine },
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
          icon: RiBarChartLine,
        },
        {
          label: t("aiSettings"),
          href: "/admin/ai/settings",
          icon: RiSettings3Line,
        },
        { label: t("mcp"), href: "/admin/mcp", icon: RiPlugLine },
        {
          label: t("apiKeys"),
          href: "/admin/mcp/keys",
          icon: RiKeyLine,
        },
      ],
    },
    {
      label: t("operations"),
      items: [
        {
          label: t("activity"),
          href: "/admin/activity",
          icon: RiHistoryLine,
        },
      ],
    },
    {
      label: t("system"),
      items: [
        {
          label: t("settings"),
          href: "/admin/settings",
          icon: RiSettings3Line,
        },
      ],
    },
  ]

  const pathname = usePathname()
  const { resolvedTheme, setTheme } = useTheme()
  const initials = (user.name ?? user.email ?? "U")
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase()

  return (
    <Sidebar collapsible="icon">
      {/* ── Header ──────────────────────────────────────── */}
      <SidebarHeader className="mb-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              className="flex items-center p-0 hover:bg-transparent"
            >
              <Link href="/admin" className="max-h-[42px] pl-0">
                <Logo brand={config.site} />
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
                    item.href === "/admin"
                      ? pathname === "/admin"
                      : pathname.startsWith(item.href)
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild
                        isActive={active}
                        tooltip={item.label}
                      >
                        <Link href={item.href}>
                          <item.icon aria-hidden="true" />
                          <span className="truncate">{item.label}</span>
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
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={
                resolvedTheme === "dark"
                  ? tDashboard("darkMode")
                  : tDashboard("lightMode")
              }
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
          <LanguageSelector />
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
                  <div className="flex-1 overflow-hidden text-left leading-tight group-data-[collapsible=icon]:hidden">
                    <p className="truncate text-sm font-semibold">
                      {user.name}
                    </p>
                    <p className="truncate text-xs text-sidebar-foreground/70">
                      {user.email}
                    </p>
                  </div>
                  <RiExpandUpDownLine
                    className="ml-auto size-4 text-sidebar-foreground/50 group-data-[collapsible=icon]:hidden"
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

      <SidebarRail />
    </Sidebar>
  )
}
