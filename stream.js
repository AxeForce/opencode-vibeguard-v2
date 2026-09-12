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
 * Wrap a LanguageModelV3 so placeholder values are restored in the model output
 * before OpenCode consumes it. Delegates every other member to the original.
 *
 * @param {object} original LanguageModelV3 instance
 * @param {{ prefix: string, lookup: (ph: string) => string | undefined, debug?: boolean }} options
 */
export function createRestoredLanguageModel(original, options) {
  if (!original || typeof original !== "object") return original
  if (typeof original.doStream !== "function") return original

  const restorer = createStreamRestorer(options.prefix, options.lookup)
  const debug = Boolean(options.debug)

  const doGenerate =
    typeof original.doGenerate === "function"
      ? async (callOptions) => {
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
    if (!result || !result.stream) return result

    let restored = 0
    const stream = result.stream.pipeThrough(
      new TransformStream({
        transform(part, controller) {
          if (!part || typeof part !== "object") {
            controller.enqueue(part)
            return
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
