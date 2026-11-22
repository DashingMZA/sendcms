"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { authClient } from "@sendcms/auth/client"

import { useTheme } from "next-themes"
import config from "@/config/config.json"
import { Logo } from "@sendcms/ui"
import { LanguageSelector } from "@/components/dashboard/language-selector"
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
}

export function AppSidebar({
  user,
  domainCount,
  formCount,
  inboxCount,
  side,
}: Props) {
  const router = useRouter()
  const navGroups: NavGroup[] = [
    {
      label: "Application",
      items: [
        { label: "Overview", href: "/dashboard", icon: RiDashboardLine },
        {
          label: "Domains",
          href: "/dashboard/domains",
          icon: RiLinksLine,
          badge: domainCount,
        },
        {
          label: "Forms",
          href: "/dashboard/forms",
          icon: RiFileListLine,
          badge: formCount,
        },
        {
          label: "Inbox",
          href: "/dashboard/inbox",
          icon: RiInboxLine,
          badge: inboxCount,
        },
        {
          label: "Notifications",
          href: "/dashboard/notifications",
          icon: RiNotificationLine,
        },
        {
          label: "Analytics",
          href: "/dashboard/analytics",
          icon: RiBarChartLine,
        },
        {
          label: "API & SDK",
          href: "/dashboard/api",
          icon: RiCodeSSlashLine,
        },
        {
          label: "API Keys",
          href: "/dashboard/api-keys",
          icon: RiKeyLine,
        },
        {
          label: "AI",
          href: "/dashboard/ai",
          icon: RiRobotLine,
        },
        {
          label: "Support",
          href: "/dashboard/support",
          icon: RiCustomerServiceLine,
        },
      ],
    },
    {
      label: "My Account",
      items: [
        { label: "Profile", href: "/dashboard/account", icon: RiUserLine },
        {
          label: "Billing",
          href: "/dashboard/billing",
          icon: RiWalletLine,
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
              <Link href="/dashboard" className="max-h-[42px] ps-0">
                <Logo brand={config.site} />
              </Link>
            </SidebarMenuButton>
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
                  tooltip="New form"
                  className="border-2 border-dashed border-primary/40 bg-primary/5 py-5 text-primary/70 transition-colors duration-200 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:py-2 group-data-[collapsible=icon]:text-sidebar-foreground hover:bg-primary/10 hover:text-primary group-data-[collapsible=icon]:hover:bg-primary/10 group-data-[collapsible=icon]:hover:text-primary"
                >
                  <Link href="/dashboard/forms/new">
                    <RiAddLine className="size-4 shrink-0" aria-hidden="true" />
                    <span className="text-sm font-medium group-data-[collapsible=icon]:hidden">
                      New form
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
                  const active =
                    item.href === "/dashboard"
                      ? pathname === "/dashboard"
                      : pathname.startsWith(item.href)
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
                            <span className="ms-auto me-1 text-xs font-bold group-data-[collapsible=icon]:hidden">
                              {item.badge}
                            </span>
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
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={{
                children: resolvedTheme === "dark" ? "Dark mode" : "Light mode",
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
                {resolvedTheme === "dark" ? "Dark mode" : "Light mode"}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <LanguageSelector side={side} />
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
                  Sign out
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
