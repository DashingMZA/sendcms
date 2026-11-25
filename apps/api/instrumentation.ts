// SDK-016: startup checks live in instrumentation-node.ts. The check
// needs the database (Node-only), so that module is dynamically
// imported only in the Node.js runtime: a static import here would
// break the Edge instrumentation compile (Prisma uses node: modules)
// and wedge the server.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { runStartupChecks } = await import("./instrumentation-node")
    await runStartupChecks()
  }
}
