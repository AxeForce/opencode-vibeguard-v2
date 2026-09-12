import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildPatternSet } from "../patterns.js"
import { redactText } from "../engine.js"
import { redactDeep, restoreDeep } from "../deep.js"
import { PlaceholderSession } from "../session.js"
import { createStreamRestorer, createRestoredLanguageModel, createHttpResponseTransformer } from "../stream.js"
import { loadConfig } from "../config.js"
import plugin from "../index.js"

const API_KEY = "sk-" + "A".repeat(48)
const EMAIL = ["red-team", "example.org"].join("@")
const EXCLUDED_EMAIL = ["excluded", "example.org"].join("@")

function makeConfigDir(config) {
  const dir = mkdtempSync(join(tmpdir(), "vibeguard-test-"))
  writeFileSync(join(dir, "vibeguard.config.json"), JSON.stringify(config))
  return dir
}

const PATTERNS = buildPatternSet({
  regex: [{ pattern: "sk-[A-Za-z0-9]{48}", category: "OPENAI_KEY" }],
  keywords: [{ value: "my-api-key-123", category: "API_KEY" }],
  builtin: ["email", "uuid", "ipv4"],
  exclude: [EXCLUDED_EMAIL],
})

test("engine: redacts and matches expected categories", () => {
  const session = new PlaceholderSession({ prefix: "__VG_", ttlMs: 60_000, maxMappings: 100 })
  const result = redactText(`mail me at ${EMAIL} or use ${API_KEY} and my-api-key-123`, PATTERNS, session)
  assert.match(result.text, /__VG_EMAIL_[a-f0-9]{12}__/)
  assert.match(result.text, /__VG_OPENAI_KEY_[a-f0-9]{12}__/)
  assert.match(result.text, /__VG_API_KEY_[a-f0-9]{12}__/)
  assert.ok(!result.text.includes(EMAIL))
  assert.ok(!result.text.includes(API_KEY))
  assert.ok(!result.text.includes("my-api-key-123"))
})

test("engine: exclude list and idempotency", () => {
  const session = new PlaceholderSession({ prefix: "__VG_", ttlMs: 60_000, maxMappings: 100 })
  const excluded = redactText(`reach me at ${EXCLUDED_EMAIL}`, PATTERNS, session)
  assert.equal(excluded.text, `reach me at ${EXCLUDED_EMAIL}`)
  const once = redactText(`key ${API_KEY}`, PATTERNS, session).text
  const twice = redactText(once, PATTERNS, session).text
  assert.equal(twice, once)
})

test("engine: invalid regex is reported, valid rules survive", () => {
  const patterns = buildPatternSet({
    regex: [
      { pattern: "(", category: "BROKEN" },
      { pattern: "sk-[A-Za-z0-9]{48}", category: "OPENAI_KEY" },
    ],
  })
  assert.equal(patterns.errors.length, 1)
  assert.equal(patterns.regex.length, 1)
  const session = new PlaceholderSession({ prefix: "__VG_", ttlMs: 60_000, maxMappings: 100 })
  const result = redactText(`key ${API_KEY}`, patterns, session)
  assert.match(result.text, /__VG_OPENAI_KEY_[a-f0-9]{12}__/)
})

test("deep: redact and restore nested structures", () => {
  const session = new PlaceholderSession({ prefix: "__VG_", ttlMs: 60_000, maxMappings: 100 })
  const input = { nested: { list: [`key ${API_KEY}`, 42, { deep: EMAIL }] } }
  redactDeep(input, PATTERNS, session)
  assert.ok(!JSON.stringify(input).includes(API_KEY))
  assert.ok(!JSON.stringify(input).includes(EMAIL))
  restoreDeep(input, session)
  assert.equal(input.nested.list[0], `key ${API_KEY}`)
  assert.equal(input.nested.list[2].deep, EMAIL)
})

test("stream restorer: placeholder split across chunks is restored", () => {
  const session = new PlaceholderSession({ prefix: "__VG_", ttlMs: 60_000, maxMappings: 100 })
  const original = ["secret", "example.org"].join("@")
  const placeholder = session.getOrCreatePlaceholder(original, "EMAIL")
  const restorer = createStreamRestorer("__VG_", (ph) => session.lookup(ph))

  const chunks = [
    "your email is " + placeholder.slice(0, 8),
    placeholder.slice(8, 20),
    placeholder.slice(20) + " ok",
  ]
  let pending = ""
  let out = ""
  for (const chunk of chunks) {
    const next = restorer.push(pending, chunk)
    out += next.emit
    pending = next.pending
  }
  out += restorer.flush(pending)
  assert.equal(out, `your email is ${original} ok`)
})

test("stream restorer: impossible placeholder start is emitted, partial tail held", () => {
  const session = new PlaceholderSession({ prefix: "__VG_", ttlMs: 60_000, maxMappings: 100 })
  const restorer = createStreamRestorer("__VG_", (ph) => session.lookup(ph))

  const stray = restorer.push("", "__VG_not a placeholder")
  assert.equal(stray.emit, "__VG_not a placeholder")
  assert.equal(stray.pending, "")

  const partial = restorer.push("", "text __VG_EMAIL_ab")
  assert.equal(partial.emit, "text ")
  assert.equal(partial.pending, "__VG_EMAIL_ab")

  const resolved = restorer.push(partial.pending, "c def")
  assert.equal(resolved.emit, "__VG_EMAIL_abc def")
  assert.equal(resolved.pending, "")
})

test("stream restorer: unknown placeholder is passed through", () => {
  const session = new PlaceholderSession({ prefix: "__VG_", ttlMs: 60_000, maxMappings: 100 })
  const restorer = createStreamRestorer("__VG_", (ph) => session.lookup(ph))
  const unknown = "__VG_EMAIL_0123456789ab__"
  const result = restorer.push("", `hello ${unknown}`)
  assert.equal(result.emit, `hello ${unknown}`)
})

test("http response transformer: restores placeholder split across byte chunks", async () => {
  const session = new PlaceholderSession({ prefix: "__VG_", ttlMs: 60_000, maxMappings: 100 })
  const original = ["secret", "example.org"].join("@")
  const placeholder = session.getOrCreatePlaceholder(original, "EMAIL")
  const transformer = createHttpResponseTransformer("__VG_", (ph) => session.lookup(ph))

  const encoder = new TextEncoder()
  const bytes = encoder.encode(`data: {"delta":"${placeholder}"}\n\n`)
  const cut = bytes.indexOf(encoder.encode("__VG_")) + 6

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, cut))
      controller.enqueue(bytes.slice(cut))
      controller.close()
    },
  }).pipeThrough(transformer)

  const decoder = new TextDecoder()
  let out = ""
  for await (const chunk of stream) out += decoder.decode(chunk, { stream: true })
  out += decoder.decode()
  assert.equal(out, `data: {"delta":"${original}"}\n\n`)
})

test("language model wrapper: doStream restores split text deltas", async () => {
  const session = new PlaceholderSession({ prefix: "__VG_", ttlMs: 60_000, maxMappings: 100 })
  const original = ["secret", "example.org"].join("@")
  const placeholder = session.getOrCreatePlaceholder(original, "EMAIL")

  const parts = [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: "your email is " + placeholder.slice(0, 6) },
    { type: "text-delta", id: "t1", delta: placeholder.slice(6, 18) },
    { type: "text-delta", id: "t1", delta: placeholder.slice(18) + " ok" },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: "stop", usage: {} },
  ]

  const model = {
    specificationVersion: "v3",
    provider: "fake",
    modelId: "fake-1",
    supportedUrls: {},
    async doGenerate() {
      return { content: [], finishReason: "stop", usage: {} }
    },
    async doStream() {
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part)
            controller.close()
          },
        }),
      }
    },
  }

  const wrapped = createRestoredLanguageModel(model, {
    prefix: "__VG_",
    lookup: (ph) => session.lookup(ph),
  })
  assert.equal(wrapped.provider, "fake")
  assert.equal(wrapped.modelId, "fake-1")

  const result = await wrapped.doStream({})
  const collected = []
  for await (const part of result.stream) collected.push(part)

  const text = collected
    .filter((part) => part.type === "text-delta")
    .map((part) => part.delta)
    .join("")
  assert.equal(text, `your email is ${original} ok`)
})

test("language model wrapper: doGenerate restores content", async () => {
  const session = new PlaceholderSession({ prefix: "__VG_", ttlMs: 60_000, maxMappings: 100 })
  const original = ["secret", "example.org"].join("@")
  const placeholder = session.getOrCreatePlaceholder(original, "EMAIL")

  const model = {
    specificationVersion: "v3",
    provider: "fake",
    modelId: "fake-1",
    supportedUrls: {},
    async doGenerate() {
      return {
        content: [
          { type: "text", text: `email: ${placeholder}` },
          { type: "tool-call", toolCallId: "1", toolName: "bash", input: `{"cmd":"echo ${placeholder}"}` },
        ],
        finishReason: "stop",
        usage: {},
      }
    },
    async doStream() {
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.close()
          },
        }),
      }
    },
  }

  const wrapped = createRestoredLanguageModel(model, {
    prefix: "__VG_",
    lookup: (ph) => session.lookup(ph),
  })
  const result = await wrapped.doGenerate({})
  assert.equal(result.content[0].text, `email: ${original}`)
  assert.equal(result.content[1].input, `{"cmd":"echo ${original}"}`)
})

test("config: project config wins over fallback", async () => {
  const dir = makeConfigDir({ enabled: true, restore_stream: true })
  try {
    const config = await loadConfig(dir)
    assert.equal(config.loadedFrom, join(dir, "vibeguard.config.json"))
    assert.equal(config.enabled, true)
    assert.equal(config.restoreStream, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function mockContext(dir, hooks) {
  return {
    location: { directory: dir },
    session: {
      hook: async (name, callback) => {
        hooks.set("session:" + name, callback)
      },
    },
    tool: {
      hook: async (name, callback) => {
        hooks.set("tool:" + name, callback)
      },
    },
  }
}

test("plugin: registers hooks, redacts requests, restores tool input", async () => {
  const dir = makeConfigDir({
    enabled: true,
    restore_stream: true,
    patterns: {
      regex: [{ pattern: "sk-[A-Za-z0-9]{48}", category: "OPENAI_KEY" }],
      builtin: ["email"],
      exclude: [],
    },
  })
  try {
    const hooks = new Map()
    await plugin.setup(mockContext(dir, hooks))

    assert.deepEqual(
      [...hooks.keys()].sort(),
      [
        "session:compaction",
        "session:context",
        "session:generate",
        "session:http.response",
        "session:title",
        "tool:execute.before",
      ].sort(),
    )

    const context = hooks.get("session:context")
    const event = {
      sessionID: "ses_test",
      system: [{ type: "text", text: `system ${API_KEY}` }],
      messages: [{ role: "user", content: [{ type: "text", text: `mail ${EMAIL} key ${API_KEY}` }] }],
    }
    context(event)
    assert.match(event.system[0].text, /__VG_OPENAI_KEY_[a-f0-9]{12}__/)
    assert.match(event.messages[0].content[0].text, /__VG_EMAIL_[a-f0-9]{12}__/)

    const tool = hooks.get("tool:execute.before")
    const toolEvent = { sessionID: "ses_test", input: { content: event.messages[0].content[0].text } }
    tool(toolEvent)
    assert.ok(toolEvent.input.content.includes(EMAIL))
    assert.ok(toolEvent.input.content.includes(API_KEY))

    const httpHook = hooks.get("session:http.response")
    const redactedText = event.messages[0].content[0].text
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`data: {"text":"${redactedText}"}\n\n`))
        controller.close()
      },
    })
    const responseEvent = {
      sessionID: "ses_test",
      response: new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    }
    httpHook(responseEvent)
    const rewritten = await new Response(responseEvent.response.body).text()
    assert.ok(rewritten.includes(EMAIL))
    assert.ok(rewritten.includes(API_KEY))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("plugin: http.response hook is not registered when restore_stream is off", async () => {
  const dir = makeConfigDir({ enabled: true, restore_stream: false })
  try {
    const hooks = new Map()
    await plugin.setup(mockContext(dir, hooks))
    assert.ok(!hooks.has("session:http.response"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("plugin: disabled config is a no-op", async () => {
  const dir = makeConfigDir({ enabled: false })
  try {
    const hooks = new Map()
    await plugin.setup(mockContext(dir, hooks))
    assert.equal(hooks.size, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
