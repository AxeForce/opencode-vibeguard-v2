import { getPlaceholderRegex } from "./session.js"

/**
 * Restore placeholders in a string; unknown placeholders are left as-is.
 * @param {string} input
 * @param {{ prefix: string, lookup(ph: string): string | undefined }} session
 */
export function restoreText(input, session) {
  const text = String(input ?? "")
  if (!text) return text
  const re = getPlaceholderRegex(session.prefix)
  return text.replace(re, (ph) => session.lookup(ph) ?? ph)
}
