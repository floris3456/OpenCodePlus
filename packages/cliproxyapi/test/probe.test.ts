import { afterAll, expect, test } from "bun:test"
import { probeQuota } from "../src/quota/probe.js"

const EVENTS = "/v0/resource/plugins/quota-handoff/events"

// One stub CPA; the path's first segment picks how its quota endpoint answers.
const seen: { path: string; authorization: string | null }[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    seen.push({ path: url.pathname, authorization: request.headers.get("authorization") })
    if (url.pathname !== EVENTS) return new Response("not found", { status: 404 })
    return answers[current]!()
  },
})
afterAll(() => server.stop(true))

const answers: Record<string, () => Response | Promise<Response>> = {
  present: () => Response.json({ mode: "shadow", protocol: 1 }),
  // An oauth2-proxy in front of CPA sends unknown plugins to its login page.
  login: () => new Response(null, { status: 302, headers: { location: "/oauth2/start" } }),
  missing: () => new Response("404 page not found", { status: 404 }),
  html: () => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }),
  future: () => Response.json({ protocol: 2 }),
  slow: async () => {
    await Bun.sleep(500)
    return Response.json({ protocol: 1 })
  },
}
let current = "present"
const origin = () => `http://127.0.0.1:${server.port}`

test("a CPA running quota-handoff turns quota on, and the probe sends no key", async () => {
  current = "present"
  seen.length = 0
  expect(await probeQuota(origin(), { fetch })).toBe(true)
  expect(seen).toEqual([
    { path: "/v0/resource/plugins/pacer/events", authorization: null },
    { path: EVENTS, authorization: null },
  ])
})

test.each(["login", "missing", "html", "future"])("a CPA answering %s leaves quota off", async (answer) => {
  current = answer
  expect(await probeQuota(origin(), { fetch })).toBe(false)
})

test("a CPA that does not answer in time leaves quota off", async () => {
  current = "slow"
  const started = Date.now()
  expect(await probeQuota(origin(), { fetch, timeout: 100 })).toBe(false)
  expect(Date.now() - started).toBeLessThan(450)
})

test("an origin quota refuses is never contacted", async () => {
  const contacted: string[] = []
  const recording = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      contacted.push(String(input))
      return Response.json({ protocol: 1 })
    },
    { preconnect: fetch.preconnect },
  )
  expect(await probeQuota("http://cpa.example.com", { fetch: recording })).toBe(false)
  expect(await probeQuota("https://user:pass@cpa.example.com", { fetch: recording })).toBe(false)
  expect(await probeQuota("not a url", { fetch: recording })).toBe(false)
  expect(contacted).toEqual([])
  // Control: the same recording fetch is used for an origin quota accepts.
  expect(await probeQuota("https://cpa.example.com", { fetch: recording })).toBe(true)
  expect(contacted).toEqual([
    `https://cpa.example.com/v0/resource/plugins/pacer/events`,
    `https://cpa.example.com${EVENTS}`,
  ])
})
