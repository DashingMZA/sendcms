// Email worker startup fail-fast (SRC-320): with DATABASE_URL unset
// the entry point must exit non-zero instead of polling forever
// against pg's localhost fallback. Spawns the real entry point in a
// bare temp directory (so no workspace .env can supply the variable)
// with DATABASE_URL removed from the environment.
import { execFile } from "node:child_process"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const execFileAsync = promisify(execFile)

describe("email worker startup (SRC-320)", () => {
  it("exits non-zero when DATABASE_URL is unset", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sendcms-worker-startup-"))
    const tsx = join(
      process.cwd(),
      "services/email-worker/node_modules/.bin/tsx"
    )
    const entry = join(process.cwd(), "services/email-worker/src/index.ts")
    const env = { ...process.env }
    delete env.DATABASE_URL
    try {
      await execFileAsync(tsx, [entry], { cwd: dir, env, timeout: 20_000 })
      expect.unreachable("worker started without DATABASE_URL")
    } catch (err) {
      const error = err as {
        code?: number
        stdout?: string
        stderr?: string
        killed?: boolean
      }
      expect(error.killed).not.toBe(true)
      expect(error.code).toBe(1)
      expect(`${error.stdout ?? ""}${error.stderr ?? ""}`).toContain(
        "DATABASE_URL"
      )
    }
  }, 30_000)
})
