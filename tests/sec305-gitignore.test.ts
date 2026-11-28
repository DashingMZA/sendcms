// SEC-305 — regression test: dev-server logs and generated SDK files must
// stay out of git. A real verification token was once committed in the
// tracked `.dev-server.log` (added `a772004`, pre-baseline); the owner
// decided (2026-11-28) to remove it from the index and ignore the logs
// rather than rewrite history. This test guards the ignore rules so a
// future `git add -A` can never re-commit a log or the generated forms.
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const ROOT = path.resolve(__dirname, "..")

function git(args: string): string {
  return execSync(`git ${args}`, { cwd: ROOT, encoding: "utf8" })
}

describe("SEC-305 gitignore guards", () => {
  it("root .gitignore covers .dev-server*.log and apps/api/public/forms/", () => {
    const gitignore = readFileSync(path.join(ROOT, ".gitignore"), "utf8")
    expect(gitignore).toContain(".dev-server*.log")
    expect(gitignore).toContain("apps/api/public/forms/")
  })

  it("git check-ignore reports the log files and generated forms as ignored", () => {
    const ignored = git(
      "check-ignore .dev-server.log .dev-server-api.log apps/api/public/forms/v1.js"
    )
    expect(ignored).toContain(".dev-server.log")
    expect(ignored).toContain(".dev-server-api.log")
    expect(ignored).toContain("apps/api/public/forms/v1.js")
  })

  it(".dev-server.log is not tracked (removed from the index)", () => {
    const tracked = git("ls-files")
    expect(tracked.split("\n")).not.toContain(".dev-server.log")
  })
})
