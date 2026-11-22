// Platform operations (Admin Control Plane, Phase 7) — service
// barrel. The per-domain services live in their own files
// (flags, announcements, audit, health, abuse, deletion,
// translations); this file re-exports them so callers import one
// module, the same shape as the mcp-admin / plans modules.
export * from "./abuse"
export * from "./announcements"
export * from "./audit"
export * from "./deletion"
export * from "./flags"
export * from "./health"
export * from "./require-admin"
export * from "./translations"
