import { afterEach, expect, test } from "bun:test"
import { fingerprintWireBody, sha256 } from "../src/monitor/fingerprint.js"
import { prefixDiff } from "../src/monitor/cache.js"
import { queryMonitor } from "../src/monitor/query.js"
import { cleanupLedgers, ledger } from "./monitor-fixture.js"

afterEach(cleanupLedgers)

const schemaSecret = "SYNTHETIC_SCHEMA_KEY_SECRET_9c11"
const topSecret = "SYNTHETIC_TOP_OPTION_SECRET_3b42"
const nestedSecret = "SYNTHETIC_NESTED_KEY_SECRET_7d83"

const schema = {
  type: "object",
  properties: {
    [schemaSecret]: {
      type: "object",
      properties: {
        [nestedSecret]: { type: "string" },
        // The generic marker walker also visits schema definitions. Its path
        // must not accidentally reveal the enclosing authored property name.
        cache_control: { type: "object" },
      },
    },
  },
}

test("dynamic option/schema key names never enter direct, persisted or exported diagnostics", async () => {
  const db = await ledger()
  db.session({ id: "privacy" }, 1)
  for (const protocol of ["openai-chat", "openai-responses", "anthropic-messages"] as const) {
    const body = {
      messages: [{ role: "user", content: "fixture" }], input: "fixture",
      response_format: { type: "json_schema", json_schema: { schema } },
      text: { format: { type: "json_schema", schema }, [nestedSecret]: { value: "fixture" } },
      output_config: { format: { type: "json_schema", schema } },
      [topSecret]: { [nestedSecret]: { value: "fixture" } },
    }
    const a = { requestID: `${protocol}-a`, sessionID: "privacy", ...fingerprintWireBody({ ...body, text: { ...body.text, format: { type: "text" } } }, { protocol }) }
    const b = { requestID: `${protocol}-b`, sessionID: "privacy", ...fingerprintWireBody(body, { protocol }) }
    expect(prefixDiff(a, b).reusable).toBe(false)
    expect(Object.keys(b.optionsKeys)).toContain(`unknown[${sha256(topSecret)}]`)
    expect(b.optionsKeys["text.format.schema"]).toBeDefined()
    expect(Object.keys(b.optionsKeys).some((key) => key.startsWith("text.format.schema."))).toBe(false)
    for (const [index, wire] of [a, b].entries()) {
      db.requestStarted({ id: wire.requestID, sessionID: "privacy", kind: "step", provider: "synthetic", model: protocol, started: 10 + index * 10 })
      db.requestEnded(wire.requestID, { ended: 11 + index * 10, status: "completed" })
      db.requestFingerprint(wire)
    }
    const exported = queryMonitor(db, { scope: "session", sessionID: "privacy", view: "cache", id: b.requestID }, { now: 100 })
    expect(exported.detail?.segments.length).toBeGreaterThan(0)
    for (const secret of [schemaSecret, topSecret, nestedSecret]) {
      expect(JSON.stringify(b)).not.toContain(secret)
      expect(JSON.stringify(prefixDiff(a, b))).not.toContain(secret)
      expect(JSON.stringify(db.db.query("select * from request_fingerprint").all())).not.toContain(secret)
      expect(JSON.stringify(db.getFingerprint(b.requestID))).not.toContain(secret)
      expect(JSON.stringify(exported)).not.toContain(secret)
    }
  }
})

test("whole schema/unknown subtree hashes retain key and value changes after label redaction", () => {
  const make = (body: object) => ({ requestID: "fixture", sessionID: "privacy", ...fingerprintWireBody({ input: "fixture", ...body }) })
  const controls = [
    [{ text: { format: { type: "json_schema", schema: { properties: { [schemaSecret]: { type: "string" } } } } } }, { text: { format: { type: "json_schema", schema: { properties: { renamed: { type: "string" } } } } } }],
    [{ text: { format: { type: "json_schema", schema: { properties: { [schemaSecret]: { type: "string" } } } } } }, { text: { format: { type: "json_schema", schema: { properties: { [schemaSecret]: { type: "number" } } } } } }],
    [{ [topSecret]: { value: "a" } }, { renamed: { value: "a" } }],
    [{ [topSecret]: { [nestedSecret]: "a" } }, { [topSecret]: { renamed: "a" } }],
    [{ [topSecret]: { [nestedSecret]: "a" } }, { [topSecret]: { [nestedSecret]: "b" } }],
    [{ text: { verbosity: "low", [nestedSecret]: { value: "a" } } }, { text: { verbosity: "low", [nestedSecret]: { value: "b" } } }],
    [{ text: { format: { type: "text", [nestedSecret]: { value: "a" } } } }, { text: { format: { type: "text", renamed: { value: "a" } } } }],
    [{ "text.format.schema": { type: "object" } }, { text: { format: { schema: { type: "object" } } } }],
    [{ text: { "format.schema": { type: "object" } } }, { text: { format: { schema: { type: "object" } } } }],
  ]
  for (const [before, after] of controls) {
    const a = make(before!)
    const b = make(after!)
    expect(a.optionsHash).not.toBe(b.optionsHash)
    expect(prefixDiff(a, b)).toMatchObject({ known: true, reusable: false })
    for (const secret of [schemaSecret, topSecret, nestedSecret]) expect(JSON.stringify([a, b, prefixDiff(a, b)])).not.toContain(secret)
  }
})

test("fixed option paths stay readable and canonical key reordering stays equal", () => {
  const a = fingerprintWireBody({ input: "fixture", prompt_cache_options: { ttl: "1h" }, text: { format: { type: "json_schema", schema: { type: "object", properties: { [schemaSecret]: { type: "string" } } } } } })
  const b = fingerprintWireBody({ text: { format: { schema: { properties: { [schemaSecret]: { type: "string" } }, type: "object" }, type: "json_schema" } }, prompt_cache_options: { ttl: "1h" }, input: "fixture" })
  expect(a.optionsKeys["prompt_cache_options.ttl"]).toBe(sha256(JSON.stringify("1h")))
  expect(a.optionsKeys["text.format.type"]).toBeDefined()
  expect(a.optionsHash).toBe(b.optionsHash)
  expect(prefixDiff({ requestID: "a", sessionID: "privacy", ...a }, { requestID: "b", sessionID: "privacy", ...b }).reusable).toBe(true)
})
