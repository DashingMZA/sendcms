# UI Components

**Stack:** shadcn/ui (radix-luma style) · Tailwind v4 · Remix icons · Do NOT import Radix primitives directly.

**Config:** `components.json` — style: radix-luma, baseColor: mauve, cssVariables: true, iconLibrary: remixicon

**Add new component:** `npx shadcn@latest add <component>`

## Design Tokens

**Always style with the existing tokens** in `styles/design-tokens.css`. They define `:root` + `.dark` and are exposed as Tailwind v4 utilities via `@theme inline` — so use the utility, never a raw value. This keeps dark mode, theming, and the radix-luma palette consistent for free.

| Token group | Tailwind utility                                                      | Use for                                 |
| ----------- | --------------------------------------------------------------------- | --------------------------------------- |
| Surface     | `bg-background`, `bg-card`, `bg-popover`, `bg-sidebar`                | Page, card, dropdown, sidebar surfaces  |
| Text        | `text-foreground`, `text-muted-foreground`, `text-card-foreground`    | Body, secondary, on-surface text        |
| Brand       | `bg-primary` / `text-primary-foreground`, `bg-secondary`, `bg-accent` | Primary actions, accents                |
| Feedback    | `bg-destructive` / `text-destructive-foreground`                      | Errors, delete actions                  |
| Lines       | `border-border`, `border-input`, `ring-ring`                          | Borders, inputs, focus rings            |
| Charts      | `fill-chart-1` … `fill-chart-5` (or `var(--chart-N)`)                 | Recharts series — never pick ad-hoc hex |
| Radius      | `rounded-sm` / `rounded-md` / `rounded-lg` / `rounded-xl`             | All corners (scale off `--radius`)      |
| Shadow      | `shadow-xs` … `shadow-2xl`                                            | Elevation                               |
| Type scale  | `text-step--2` … `text-step-5`                                        | Fluid headings/body (Utopia scale)      |
| Tracking    | `tracking-tight` / `tracking-normal` / `tracking-wide`                | Letter-spacing                          |

**Rules:**

- Never hardcode a color (`#0f172a`, `oklch(...)`, `rgb(...)`) or arbitrary class (`bg-[#...]`, `text-[14px]`). Reach for the token utility instead.
- Need a value with no utility? Reference the CSS var directly: `style={{ color: "var(--primary)" }}` or `className="bg-[var(--accent)]"` — don't reinvent the value.
- Tokens flip automatically in `.dark`. Write light-mode classes; dark mode follows. Don't add `dark:` overrides for colors that are already tokenized.
- Missing a token you genuinely need? Add it to `styles/design-tokens.css` (both `:root` and `.dark`, plus the `@theme inline` map) — don't inline a one-off.

## shadcn/ui Primitives

| Component    | Import                        | Used By                                     |
| ------------ | ----------------------------- | ------------------------------------------- |
| Button       | `components/ui/button`        | Everywhere                                  |
| ButtonGroup  | `components/ui/button-group`  | —                                           |
| Card         | `components/ui/card`          | Settings sections, stat cards               |
| Dialog       | `components/ui/dialog`        | Delete confirm, edit, profile, transfer     |
| Sheet        | `components/ui/sheet`         | Mobile sidebar                              |
| Table        | `components/ui/table`         | Inbox, forms tables                         |
| Tabs         | `components/ui/tabs`          | Inbox tabs, notifications tabs              |
| Select       | `components/ui/select`        | Filters, theme picker                       |
| Badge        | `components/ui/badge`         | Role badges, status badges, nav counts      |
| Skeleton     | `components/ui/skeleton`      | All `loading.tsx` files                     |
| Avatar       | `components/ui/avatar`        | User display                                |
| Input        | `components/ui/input`         | Forms, search                               |
| Textarea     | `components/ui/textarea`      | Form fields, messages                       |
| Checkbox     | `components/ui/checkbox`      | Bulk select                                 |
| Switch       | `components/ui/switch`        | Toggle settings                             |
| Tooltip      | `components/ui/tooltip`       | Icon hints                                  |
| Separator    | `components/ui/separator`     | Visual dividers                             |
| Label        | `components/ui/label`         | Form labels                                 |
| ScrollArea   | `components/ui/scroll-area`   | Sidebar, filter panel                       |
| Sonner       | `components/ui/sonner`        | Toast notifications (via `toast.success()`) |
| Chart        | `components/ui/chart`         | Recharts wrapper                            |
| DropdownMenu | `components/ui/dropdown-menu` | Row actions, user menu                      |

## Dashboard Components

| Component                   | Path                                                       | Type   | Use                                              |
| --------------------------- | ---------------------------------------------------------- | ------ | ------------------------------------------------ |
| `AppSidebar`                | `dashboard/app-sidebar`                                    | Client | Main nav sidebar                                 |
| `PageHeader`                | `dashboard/page-header`                                    | Server | Page title + description + action slot           |
| `InboxTable`                | `dashboard/inbox/inbox-table`                              | Client | Submission list + tabs, search, filters, bulk actions |
| `SubmissionDetail`          | `dashboard/inbox/submission-detail`                        | Client | Sender, field values, history timeline, actions    |
| `SubmissionStatusBadge`     | `dashboard/inbox/submission-status-badge`                  | Server | Status chip: NEW/READ/STARRED/ARCHIVED/SPAM        |
| `InboxSearchInput`          | `dashboard/inbox/inbox-search-input`                       | Client | Debounced search → URL `?search=`                  |
| `SubmissionActivityChart`   | `dashboard/submission-activity-chart`                      | Client | 14/30-day area chart: `{ data: {date, count}[] }`  |
| `DomainsTable`              | `dashboard/domains/domains-table`                          | Client | Domain list + status badges                        |
| `DomainDetail`              | `dashboard/domains/[domainId]/domain-detail`               | Client | Verification instructions + copy fields            |
| `DomainStatusBadge`         | `dashboard/domains/domain-status-badge`                    | Server | Status chip: PENDING/VERIFIED/SUSPENDED            |
| `CopyField`                 | `dashboard/domains/copy-field`                             | Client | Label + mono value + copy button                   |
| `FormsTable`                | `dashboard/forms/forms-table`                              | Client | Form list + counts                                 |
| `FormDetail`                | `dashboard/forms/[formId]/form-detail`                     | Client | Settings, fields, domains, notifications, embed    |
| `FieldsSection`             | `dashboard/forms/[formId]/fields-section`                  | Client | Add/edit field form                                |
| `EmailJobsTable`            | `dashboard/notifications/email-jobs-table`                 | Client | Delivery log + status tabs                         |
| `InstallSnippet`            | `dashboard/install-snippet`                                | Client | Code display + clipboard copy                      |
| `InstallSnippetSection`     | `dashboard/site-settings-form/install-snippet-section`     | Server | Embed code card                                  |
| `ThemeToggle`               | `components/theme-toggle`                                  | Client | Dark/light mode                                  |
| `Logo`                      | `components/logo`                                          | Server | Brand logo from config                           |

## Loading / Error / Empty States

| Pattern        | Implementation                                                                        |
| -------------- | ------------------------------------------------------------------------------------- |
| Loading        | `loading.tsx` files with `Skeleton` matching layout dimensions                        |
| Error          | `error.tsx` with AlertTriangle icon + "Try again" + nav button                        |
| Empty          | Dashed border box with icon, heading, description, CTA                                |
| Inline loading | `toast.success()`/`toast.error()`, button `disabled` + text change, `Loader2` spinner |
| Optimistic     | `useMutation`'s `onMutate` updates the React Query cache, `onError` rolls it back     |
