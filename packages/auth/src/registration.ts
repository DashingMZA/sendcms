import { db } from "@sendcms/database"
import { createLogger } from "@sendcms/observability"

const logger = createLogger("auth")

// DOC-003 (D14): the single shared reader for the `registration`
// FeatureFlag. The auth package is a documented `@sendcms/database`
// importer (see tests/architecture-db-imports.test.ts), so the flag
// is read here directly instead of through @sendcms/platform-ops —
// platform-ops imports the AdminSession type from auth, so a value
// import the other way would be a layering inversion.
//
// Fail-closed, like `isFeatureEnabled` in platform-ops (minus the
// per-user override — overrides make no sense for a platform-wide
// registration gate): a missing row or a DB error returns false and
// logs, so a lookup failure can never open registration by accident.
// No cache in v1: sign-up is infrequent; a direct read is always fresh.
export async function isRegistrationEnabled(): Promise<boolean> {
  try {
    const flag = await db.featureFlag.findUnique({
      where: { key: "registration" },
      select: { isEnabled: true },
    })
    if (!flag) {
      logger.warn("[auth] registration flag missing, defaulting to closed", {
        key: "registration",
      })
      return false
    }
    return flag.isEnabled
  } catch (err) {
    logger.warn(
      "[auth] registration flag lookup failed, defaulting to closed",
      { error: err, key: "registration" }
    )
    return false
  }
}
