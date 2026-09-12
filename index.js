import { appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "./config.js"
import { buildPatternSet } from "./patterns.js"
import { PlaceholderSession } from "./session.js"
import { redactText } from "./engine.js"
import { redactDeep, restoreDeep } from "./deep.js"
import { createRestoredLanguageModel } from "./stream.js"

/**
 * Trace helper for debugging hook wiring. Enabled by config `debug` or
 * `OPENCODE_VIBEGUARD_DEBUG`. Writes JSON lines to
 * `<tmpdir>/opencode-vibeguard-trace.log`.
 */
function createTrace(enabled) {
  if (!enabled) return () => {}
  const file = join(tmpdir(), "opencode-vibeguard-trace.log")
  return (event, data = {}) => {
    try {
      appendFileSync(file, `${new Date().toISOString()} ${event} ${JSON.stringify(data)}\n`)
    } catch {
      // never break a request because of tracing
    }
  }
}

/**
 * VibeGuard for OpenCode V2.
 *
 * Port of the V1 plugin `opencode-vibeguard@0.1.0` (MIT, inkdust2021):
 * https://github.com/inkdust2021/opencode-vibeguard
 *
 * V1 -> V2 hook mapping:
 * - `experimental.chat.messages.transform` -> `ctx.session.hook("context" | "compaction" | "generate" | "title")`
 *   (redact every outgoing request so the provider never sees plaintext)
 * - `tool.execute.before` -> `ctx.tool.hook("execute.before")`
 *   (restore placeholders so local tools run with real values)
 * - `experimental.text.complete` -> `ctx.aisdk.hook("language", ...)` (opt-in, `restore_stream: true`)
 *   (wrap the AI SDK language model and restore placeholders in the response stream)
 *
 * Safety: the plugin is a no-op when the config file is missing or `enabled=false`.
 *
 * Note: the V2 `Plugin.define()` helper is an identity function. It is omitted here so the plugin
 * has zero package dependencies and loads from any global plugin directory.
 */
function createMessageRedactor(patterns, getSession, debug) {
  return (event) => {
    const session = getSession(event?.sessionID)
    if (!session) return
    session.cleanup()

    const messages = Array.isArray(event?.messages) ? event.messages : []
    let changed = 0

    // System parts (instructions, AGENTS.md, skills) can carry secrets too.
    const system = Array.isArray(event?.system) ? event.system : []
    for (const part of system) {
      if (!part || part.type !== "text" || typeof part.text !== "string" || !part.text) continue
      const after = redactText(part.text, patterns, session).text
      if (after === part.text) continue
      part.text = after
      changed++
    }

    for (const message of messages) {
      const content = Array.isArray(message?.content) ? message.content : []
      for (const part of content) {
        if (!part || typeof part !== "object") continue

        // User/assistant text, model reasoning, and compaction checkpoints
        if (part.type === "text" || part.type === "reasoning" || part.type === "compaction") {
          if (typeof part.text !== "string" || !part.text) continue
          const after = redactText(part.text, patterns, session).text
          if (after === part.text) continue
          part.text = after
          changed++
          continue
        }

        // Tool inputs (e.g. args captured from earlier turns)
        if (part.type === "tool-call") {
          if (part.input && typeof part.input === "object") {
            changed += redactDeep(part.input, patterns, session)
          }
          continue
        }

        // Tool outputs (e.g. file contents read by tools)
        if (part.type === "tool-result") {
          if (part.result && typeof part.result === "object") {
            changed += redactDeep(part.result, patterns, session)
          }
          continue
        }
      }
    }

    if (debug && changed > 0) {
      console.log(`[opencode-vibeguard] pre-request redaction: ${changed} fragment(s)`)
    }
  }
}

export default {
  id: "opencode-vibeguard",
  async setup(ctx) {
    const config = await loadConfig(ctx.location.directory)
    const debug = Boolean(process.env.OPENCODE_VIBEGUARD_DEBUG) || Boolean(config.debug)
    const trace = createTrace(debug)

    trace("setup", {
      directory: ctx.location?.directory,
      loadedFrom: config.loadedFrom,
      enabled: config.enabled,
      restoreStream: config.restoreStream,
    })

    if (debug) {
      const from = config.loadedFrom ? config.loadedFrom : "not found (plugin is a no-op)"
      console.log(`[opencode-vibeguard] config: ${from} enabled=${config.enabled}`)
    }

    if (!config.enabled) return

    const patterns = buildPatternSet(config.patterns)

    if (patterns.errors.length > 0) {
      for (const error of patterns.errors) {
        console.error(
          `[opencode-vibeguard] skipped invalid regex /${error.pattern}/${error.flags}: ${error.message}`,
        )
      }
    }

    const sessions = new Map()

    const getSession = (sessionID) => {
      const key = String(sessionID ?? "")
      if (!key) return null
      const existing = sessions.get(key)
      if (existing) return existing
      const created = new PlaceholderSession({
        prefix: config.prefix,
        ttlMs: config.ttlMs,
        maxMappings: config.maxMappings,
      })
      sessions.set(key, created)
      return created
    }

    // The aisdk hook has no sessionID, so restore looks across every session map.
    // Placeholder keys are HMAC-derived and unique, so cross-session lookup is sound.
    const globalLookup = (placeholder) => {
      for (const session of sessions.values()) {
        const original = session.lookup(placeholder)
        if (original !== undefined) return original
      }
      return undefined
    }

    const redactRequest = createMessageRedactor(patterns, getSession, debug)

    // Register every request kind that can carry conversation state.
    await ctx.session.hook("context", redactRequest)
    await ctx.session.hook("compaction", redactRequest)
    await ctx.session.hook("generate", redactRequest)
    await ctx.session.hook("title", redactRequest)

    // Restore placeholders in tool arguments before local execution.
    await ctx.tool.hook("execute.before", (event) => {
      const session = getSession(event?.sessionID)
      if (!session) return
      session.cleanup()
      const restored = restoreDeep(event.input, session)
      if (debug && restored > 0) {
        console.log(`[opencode-vibeguard] pre-tool restore: ${restored} fragment(s)`)
      }
    })

    // Opt-in: restore placeholders in model output before OpenCode consumes it,
    // so local display and persistence contain real values (closest V2 equivalent
    // of the V1 `experimental.text.complete` hook).
    if (config.restoreStream) {
      trace("setup.aisdk-probe", {
        hasAisdk: Boolean(ctx.aisdk),
        hookType: typeof ctx.aisdk?.hook,
      })
      await ctx.aisdk.hook("sdk", (event) => {
        trace("aisdk.sdk.hook", {
          model: event?.model?.id,
          package: event?.package,
          hasSdk: Boolean(event?.sdk),
        })
      })
      await ctx.aisdk.hook("language", (event) => {
        trace("aisdk.language.hook", {
          model: event?.model?.id,
          providerID: event?.model?.providerID,
          hasLanguage: Boolean(event?.language),
          hasDoStream: typeof event?.language?.doStream === "function",
        })
        if (!event || typeof event !== "object" || !event.language) return
        event.language = createRestoredLanguageModel(event.language, {
          prefix: config.prefix,
          lookup: globalLookup,
          debug,
          trace,
        })
        trace("aisdk.language.wrapped", {
          model: event?.model?.id,
          isReplaced: event.language !== undefined,
        })
      })
      trace("setup.aisdk-registered")
    }
  },
}
