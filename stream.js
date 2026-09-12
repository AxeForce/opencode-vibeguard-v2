import { getPlaceholderRegex } from "./session.js"

function isAllowedPlaceholderChar(ch) {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "_"
  )
}

/**
 * Streaming placeholder restorer for provider text deltas.
 *
 * Placeholders can be split across stream chunks, so a trailing incomplete
 * placeholder is held back until it resolves (terminator or impossible match).
 *
 * @param {string} prefix placeholder prefix, e.g. `__VG_`
 * @param {(placeholder: string) => string | undefined} lookup placeholder -> original value
 */
export function createStreamRestorer(prefix, lookup) {
  const prefixStr = String(prefix ?? "__VG_")
  const matchRe = getPlaceholderRegex(prefixStr)

  const restore = (text) => String(text ?? "").replace(matchRe, (ph) => lookup(ph) ?? ph)

  /**
   * Feed a chunk and get everything that is safe to emit plus the held-back tail.
   * @param {string} pending tail held back from previous chunks
   * @param {string} chunk new delta
   * @returns {{ emit: string, pending: string }}
   */
  const push = (pending, chunk) => {
    const text = `${pending ?? ""}${chunk ?? ""}`
    if (!text) return { emit: "", pending: "" }

    // End of the last complete placeholder, if any.
    let lastEnd = 0
    for (const match of text.matchAll(matchRe)) {
      lastEnd = (match.index ?? 0) + match[0].length
    }

    // A partial placeholder can only start after the last complete one.
    const tail = text.slice(lastEnd)
    const start = tail.indexOf(prefixStr)
    if (start !== -1) {
      let cursor = start + prefixStr.length
      let possible = true
      while (cursor < tail.length) {
        if (!isAllowedPlaceholderChar(tail[cursor])) {
          possible = false
          break
        }
        cursor++
      }
      if (possible) {
        const holdFrom = lastEnd + start
        return { emit: restore(text.slice(0, holdFrom)), pending: text.slice(holdFrom) }
      }
    }

    return { emit: restore(text), pending: "" }
  }

  const flush = (pending) => restore(pending)

  return { push, flush, restore }
}

/**
 * Transform a provider HTTP response body so placeholders are restored before
 * OpenCode parses it. Protocol-agnostic: placeholders are plain ASCII bytes in
 * SSE / JSON payloads, so no vendor-specific parsing is needed. Partial
 * placeholders split across chunks are held back by the shared restorer.
 *
 * @param {string} prefix placeholder prefix, e.g. `__VG_`
 * @param {(placeholder: string) => string | undefined} lookup
 * @param {(event: string, data?: object) => void} [trace]
 */
export function createHttpResponseTransformer(prefix, lookup, trace = () => {}) {
  const restorer = createStreamRestorer(prefix, lookup)
  const decoder = new TextDecoder("utf-8", { fatal: false })
  const encoder = new TextEncoder()
  let pending = ""

  return new TransformStream({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true })
      if (!text) return
      const next = restorer.push(pending, text)
      pending = next.pending
      if (next.emit) controller.enqueue(encoder.encode(next.emit))
    },
    flush(controller) {
      const tail = decoder.decode()
      let rest = pending
      if (tail) {
        const next = restorer.push(rest, tail)
        rest = next.pending
        if (next.emit) controller.enqueue(encoder.encode(next.emit))
      }
      if (rest) {
        const emit = restorer.flush(rest)
        if (emit) controller.enqueue(encoder.encode(emit))
      }
      pending = ""
      trace("http.response.flush")
    },
  })
}

/**
 * Wrap a LanguageModelV3 so placeholder values are restored in the model output
 * before OpenCode consumes it. Delegates every other member to the original.
 *
 * NOT USED on OpenCode 2.0.1: `ctx.aisdk` hooks register but are never
 * triggered by the runtime. Retained for future versions that wire them.
 *
 * @param {object} original LanguageModelV3 instance
 * @param {{ prefix: string, lookup: (ph: string) => string | undefined, debug?: boolean }} options
 */
export function createRestoredLanguageModel(original, options) {
  if (!original || typeof original !== "object") return original
  if (typeof original.doStream !== "function") return original

  const restorer = createStreamRestorer(options.prefix, options.lookup)
  const debug = Boolean(options.debug)
  const trace = typeof options.trace === "function" ? options.trace : () => {}

  trace("model.wrap", { modelId: original.modelId, provider: original.provider })

  const doGenerate =
    typeof original.doGenerate === "function"
      ? async (callOptions) => {
          trace("doGenerate.called")
          const result = await original.doGenerate(callOptions)
          if (!result || !Array.isArray(result.content)) return result

          let changed = 0
          const content = result.content.map((part) => {
            if (!part || typeof part !== "object") return part
            if ((part.type === "text" || part.type === "reasoning") && typeof part.text === "string") {
              const text = restorer.restore(part.text)
              if (text !== part.text) changed++
              return { ...part, text }
            }
            if (part.type === "tool-call" && typeof part.input === "string") {
              const input = restorer.restore(part.input)
              if (input !== part.input) changed++
              return { ...part, input }
            }
            return part
          })

          if (debug && changed > 0) {
            console.log(`[opencode-vibeguard] stream restore (generate): ${changed} fragment(s)`)
          }
          return { ...result, content }
        }
      : undefined

  const pending = new Map()

  const flushKey = (key) => {
    const held = pending.get(key)
    if (!held) return undefined
    pending.delete(key)
    return restorer.flush(held)
  }

  const deltaKey = (part) => `${part.type}:${part.id}`

  const doStream = async (callOptions) => {
    const result = await original.doStream(callOptions)
    trace("doStream.called", { hasStream: Boolean(result?.stream) })
    if (!result || !result.stream) return result

    let restored = 0
    let tracedFirst = false
    const stream = result.stream.pipeThrough(
      new TransformStream({
        transform(part, controller) {
          if (!part || typeof part !== "object") {
            controller.enqueue(part)
            return
          }

          if (!tracedFirst) {
            tracedFirst = true
            trace("doStream.first-part", { type: part.type, keys: Object.keys(part).join(",") })
          }
          if (typeof part.delta === "string" && part.delta.includes("__VG_")) {
            trace("doStream.placeholder-delta", { type: part.type })
          }

          if (
            part.type === "text-delta" ||
            part.type === "reasoning-delta" ||
            part.type === "tool-input-delta"
          ) {
            const key = deltaKey(part)
            const next = restorer.push(pending.get(key) ?? "", part.delta ?? "")
            pending.set(key, next.pending)
            if (next.emit) {
              restored++
              controller.enqueue({ ...part, delta: next.emit })
            }
            return
          }

          if (
            part.type === "text-end" ||
            part.type === "reasoning-end" ||
            part.type === "tool-input-end"
          ) {
            const deltaType = `${part.type.replace("-end", "")}-delta`
            const held = flushKey(`${deltaType}:${part.id}`)
            if (held) {
              restored++
              controller.enqueue({ type: deltaType, id: part.id, delta: held })
            }
            controller.enqueue(part)
            return
          }

          if (part.type === "tool-call" && typeof part.input === "string") {
            const input = restorer.restore(part.input)
            if (input !== part.input) {
              restored++
              controller.enqueue({ ...part, input })
              return
            }
          }

          controller.enqueue(part)
        },
        flush(controller) {
          for (const [key, held] of pending.entries()) {
            const [type, id] = [key.slice(0, key.lastIndexOf(":")), key.slice(key.lastIndexOf(":") + 1)]
            const emitted = restorer.flush(held)
            if (emitted) {
              restored++
              controller.enqueue({ type, id, delta: emitted })
            }
          }
          pending.clear()
          trace("doStream.flushed", { restored })
          if (debug && restored > 0) {
            console.log(`[opencode-vibeguard] stream restore (stream): ${restored} fragment(s)`)
          }
        },
      }),
    )

    return { ...result, stream }
  }

  return {
    specificationVersion: original.specificationVersion,
    provider: original.provider,
    modelId: original.modelId,
    supportedUrls: original.supportedUrls,
    doGenerate,
    doStream,
  }
}
