/**
 * Phase 10 — observability logger tests: the JSON-line shape, the
 * stdout/stderr split, Error flattening, and LOG_LEVEL gating.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createLogger } from "@sendcms/observability"

describe("createLogger", () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>
  let stderrWrite: ReturnType<typeof vi.spyOn>
  let stdoutLines: string[]
  let stderrLines: string[]
  const prevLogLevel = process.env.LOG_LEVEL

  beforeEach(() => {
    stdoutLines = []
    stderrLines = []
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: unknown
    ) => {
      stdoutLines.push(String(chunk))
      return true
    }) as typeof process.stdout.write)
    stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(((
      chunk: unknown
    ) => {
      stderrLines.push(String(chunk))
      return true
    }) as typeof process.stderr.write)
  })

  afterEach(() => {
    stdoutWrite.mockRestore()
    stderrWrite.mockRestore()
    if (prevLogLevel === undefined) delete process.env.LOG_LEVEL
    else process.env.LOG_LEVEL = prevLogLevel
  })

  it("writes one JSON line to stdout with level, scope, message", () => {
    const logger = createLogger("api")
    logger.info("outbox run failed", { jobId: "job-1" })
    expect(stdoutLines).toHaveLength(1)
    const entry = JSON.parse(stdoutLines[0])
    expect(entry.level).toBe("info")
    expect(entry.scope).toBe("api")
    expect(entry.message).toBe("outbox run failed")
    expect(entry.jobId).toBe("job-1")
    expect(typeof entry.timestamp).toBe("string")
    expect(stderrLines).toHaveLength(0)
  })

  it("writes errors to stderr and flattens Error values", () => {
    const logger = createLogger("email-worker")
    const err = new Error("db down")
    logger.error("outbox poll failed", { error: err })
    expect(stdoutLines).toHaveLength(0)
    expect(stderrLines).toHaveLength(1)
    const entry = JSON.parse(stderrLines[0])
    expect(entry.level).toBe("error")
    expect(entry.error.name).toBe("Error")
    expect(entry.error.message).toBe("db down")
    expect(typeof entry.error.stack).toBe("string")
  })

  it("keeps a structured error code and meta when present", () => {
    const logger = createLogger("email-worker")
    const err = Object.assign(new Error("table missing"), {
      code: "P2021",
      meta: { table: "EmailJob" },
    })
    logger.error("outbox poll failed", { error: err })
    expect(stderrLines).toHaveLength(1)
    const entry = JSON.parse(stderrLines[0])
    expect(entry.error.code).toBe("P2021")
    expect(entry.error.meta).toEqual({ table: "EmailJob" })
  })

  it("gates lower levels when LOG_LEVEL is error", () => {
    process.env.LOG_LEVEL = "error"
    const logger = createLogger("api")
    logger.info("not shown")
    logger.warn("not shown either")
    logger.error("shown")
    expect(stdoutLines).toHaveLength(0)
    expect(stderrLines).toHaveLength(1)
    expect(JSON.parse(stderrLines[0]).message).toBe("shown")
  })

  it("never throws on circular fields — writes one line with [Circular] (Phase 16, SRC-315)", () => {
    const logger = createLogger("api")
    const circular: Record<string, unknown> = { name: "circular" }
    circular.self = circular
    expect(() =>
      logger.error("circular field", { data: circular })
    ).not.toThrow()
    expect(stderrLines).toHaveLength(1)
    const entry = JSON.parse(stderrLines[0])
    expect(entry.message).toBe("circular field")
    expect(entry.data.self).toBe("[Circular]")
  })

  it("never throws when the error's meta is circular (Phase 16, SRC-315)", () => {
    const logger = createLogger("api")
    const meta: Record<string, unknown> = {}
    meta.self = meta
    const err = Object.assign(new Error("db down"), { meta })
    expect(() => logger.error("audit log failed", { error: err })).not.toThrow()
    expect(stderrLines).toHaveLength(1)
    const entry = JSON.parse(stderrLines[0])
    expect(entry.error.meta.self).toBe("[Circular]")
  })

  it("never throws when the stream write itself fails (Phase 16, SRC-315)", () => {
    stdoutWrite.mockImplementation((() => {
      throw new Error("EPIPE")
    }) as typeof process.stdout.write)
    const logger = createLogger("api")
    expect(() => logger.info("lost line")).not.toThrow()
  })
})
