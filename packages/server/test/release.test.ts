import { expect, test } from "bun:test"
import { Effect } from "effect"
import { HttpApi } from "effect/unstable/httpapi"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { Api } from "../src/api"
import { startServer } from "./fixture/server"

// The public HTTP surface of a running product must never be able to replace the
// product. These tests read the real `Api` and talk to a real server process, so a
// route that promotes, activates or installs a release cannot appear unnoticed.
//
// The bounded request/status endpoints themselves are not on this surface yet:
// adding them needs `packages/protocol/src/groups/release.ts`,
// `packages/protocol/src/client.ts`, `packages/server/src/handlers/release.ts` and
// `packages/server/src/handlers.ts`, plus a client regeneration. When they land,
// the 404 assertions below become assertions about the real route's refusals.

interface RouteFact {
  readonly group: string
  readonly name: string
  readonly method: string
  readonly path: string
}

function routes(): RouteFact[] {
  const found: RouteFact[] = []
  HttpApi.reflect(Api, {
    onGroup() {},
    onEndpoint({ group, endpoint }) {
      found.push({
        group: group.identifier,
        name: endpoint.identifier,
        method: endpoint.method,
        path: endpoint.path,
      })
    },
  })
  return found
}

test("the real API exposes no route that promotes or activates a release", () => {
  const found = routes()
  expect(found.length).toBeGreaterThan(0)

  const activating = found.filter((route) => /promote|self-?update|upgrade/i.test(`${route.name} ${route.path}`))
  expect(activating).toEqual([])

  // `credential.activate` activates a stored credential, not a release build.
  const releaseActivating = found.filter(
    (route) => /release/i.test(`${route.group} ${route.name} ${route.path}`) && /activate|install/i.test(route.name),
  )
  expect(releaseActivating).toEqual([])
})

test("the real API has no release group yet, so no release route can be reached", () => {
  const found = routes()
  expect(found.filter((route) => route.group === "server.release")).toEqual([])
  expect(found.filter((route) => route.path.startsWith("/api/release"))).toEqual([])
})

it.live("a running server refuses the release request and status paths", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-release-endpoint-")))
    const server = yield* startServer(tmp.path)

    const submit = yield* Effect.promise(() =>
      fetch(new URL("/api/release/request", server.base), {
        method: "POST",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({ requestID: "rel_req_1", kind: "promote" }),
      }),
    )
    expect(submit.status).toBe(404)

    const status = yield* Effect.promise(() =>
      fetch(new URL("/api/release/request/rel_req_1", server.base), { headers: server.headers }),
    )
    expect(status.status).toBe(404)
  }),
)

it.live("every route on this surface is fenced by the real authorization middleware", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-release-auth-")))
    const server = yield* startServer(tmp.path)

    const refused = yield* Effect.promise(() => fetch(new URL("/api/server", server.base)))
    expect(refused.status).toBe(401)
    expect(refused.headers.get("www-authenticate")).toBe('Basic realm="Secure Area"')

    const allowed = yield* Effect.promise(() => fetch(new URL("/api/server", server.base), { headers: server.headers }))
    expect(allowed.status).toBe(200)
  }),
)
