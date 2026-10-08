// A fake replacement service for handover tests: answers /api/info with the
// given version and registers itself, like a freshly spawned release would.
const [registration, version] = Bun.argv.slice(2)
if (registration === undefined || version === undefined) throw new Error("usage: stub <registration> <version>")

const server: ReturnType<typeof Bun.serve> = Bun.serve({
  port: 0,
  fetch(request: Request) {
    if (new URL(request.url).pathname === "/api/info")
      return Response.json({
        version,
        pid: process.pid,
        urls: [server.url.toString()],
        paths: { tmp: "/tmp/opencode" },
      })
    return new Response(null, { status: 404 })
  },
})

await Bun.write(
  registration,
  JSON.stringify({ id: "handover-stub", version, url: server.url.toString(), pid: process.pid }),
)

const shutdown = () => {
  server.stop(true)
  process.exit(0)
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
