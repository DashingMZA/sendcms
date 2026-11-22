import type { TicketStatus } from "@sendcms/database"

// The ticket status machine (Admin Control Plane, Phase 8).
//
// CLOSED is terminal: a closed ticket is never replied to or reopened.
// RESOLVED can reopen to OPEN or close; every other state can move to
// any non-terminal state and can close. This lives in its own pure
// module (no runtime imports — the TicketStatus import is type-only
// and erased) so client components can use it without pulling the
// service — and its `@sendcms/database` import — into the browser
// bundle. The service imports it from here too.
export const TICKET_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  OPEN: ["IN_PROGRESS", "WAITING_ON_CUSTOMER", "RESOLVED", "CLOSED"],
  IN_PROGRESS: ["WAITING_ON_CUSTOMER", "RESOLVED", "CLOSED", "OPEN"],
  WAITING_ON_CUSTOMER: ["IN_PROGRESS", "RESOLVED", "CLOSED", "OPEN"],
  RESOLVED: ["OPEN", "CLOSED"],
  CLOSED: [],
}
