import { restoreText } from "./restore.js"
import { redactText } from "./engine.js"

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false
  if (Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * Deep-walk a tool argument object and restore every placeholder string in place.
 * - Only walks Array / PlainObject
 * - Uses a WeakSet to avoid infinite recursion on cycles
 * @returns {number} number of restored strings
 * @param {unknown} value
 * @param {{ prefix: string, lookup(ph: string): string | undefined }} session
 */
export function restoreDeep(value, session) {
  const seen = new WeakSet()
  let changed = 0

  const walk = (node) => {
    if (!node || typeof node !== "object") return
    if (seen.has(node)) return
    seen.add(node)

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const v = node[i]
        if (typeof v === "string") {
          const after = restoreText(v, session)
          if (after !== v) changed++
          node[i] = after
        }
        if (v && typeof v === "object") walk(v)
      }
      return
    }

    if (!isPlainObject(node)) return

    for (const key of Object.keys(node)) {
      const v = node[key]
      if (typeof v === "string") {
        const after = restoreText(v, session)
        if (after !== v) changed++
        node[key] = after
      }
      if (v && typeof v === "object") walk(v)
    }
  }

  walk(value)
  return changed
}

/**
 * Deep-walk an object and replace every sensitive string with a placeholder in place.
 * - Only walks Array / PlainObject
 * - Uses a WeakSet to avoid infinite recursion on cycles
 * @returns {number} number of redacted strings
 * @param {unknown} value
 * @param {{ keywords: Array<{value:string,category:string}>, regex: Array<{pattern:string,flags:string,category:string}>, exclude: Set<string> }} patterns
 * @param {{ getOrCreatePlaceholder(original: string, category: string): string }} session
 */
export function redactDeep(value, patterns, session) {
  const seen = new WeakSet()
  let changed = 0

  const walk = (node) => {
    if (!node || typeof node !== "object") return
    if (seen.has(node)) return
    seen.add(node)

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const v = node[i]
        if (typeof v === "string") {
          const after = redactText(v, patterns, session).text
          if (after !== v) changed++
          node[i] = after
        }
        if (v && typeof v === "object") walk(v)
      }
      return
    }

    if (!isPlainObject(node)) return

    for (const key of Object.keys(node)) {
      const v = node[key]
      if (typeof v === "string") {
        const after = redactText(v, patterns, session).text
        if (after !== v) changed++
        node[key] = after
      }
      if (v && typeof v === "object") walk(v)
    }
  }

  walk(value)
  return changed
}
