// Load the workspace .env files BEFORE any other module is imported.
// ESM evaluates imports in source order, so this file MUST stay the
// first import in index.ts: the @sendcms/database singleton reads
// DATABASE_URL at import time, and a loadEnv() call in the module body
// (after the imports) runs too late — the singleton is already built
// with an undefined connection string, which makes pg default to
// localhost:5432 and fail with ECONNREFUSED (no local Postgres there).
// dotenv.config() never overrides vars the platform already set, and
// a missing file is a no-op, so production (env from the platform) is
// unaffected.
import { config as loadEnv } from "dotenv"

// Both paths are tried because the working directory depends on how
// the worker is launched (pnpm --filter runs in the package dir; a
// direct tsx call runs in the workspace root).
loadEnv({ path: "../../.env" })
loadEnv({ path: ".env" })
