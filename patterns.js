function sanitizeCategory(input) {
  const raw = String(input ?? "").trim()
  if (!raw) return "TEXT"
  const upper = raw.toUpperCase()
  const safe = upper.replace(/[^A-Z0-9_]/g, "_").replace(/_+/g, "_")
  if (!safe) return "TEXT"
  return safe
}

/**
 * Lightweight compatibility for Go-style `(?i)` / `(?m)` prefixes (only leading flags).
 * @param {string} pattern
 * @param {string} flags
 */
function peelInlineFlags(pattern, flags) {
  let p = String(pattern ?? "")
  let f = String(flags ?? "")

  for (;;) {
    if (p.startsWith("(?i)")) {
      p = p.slice(4)
      if (!f.includes("i")) f += "i"
      continue
    }
    if (p.startsWith("(?m)")) {
      p = p.slice(4)
      if (!f.includes("m")) f += "m"
      continue
    }
    break
  }

  return { pattern: p, flags: f }
}

/**
 * Builtin rules ported from VibeGuard (JS-compatible). Low config effort, broad coverage.
 */
const BUILTIN = new Map([
  [
    "email",
    {
      pattern: String.raw`[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}`,
      flags: "i",
      category: "EMAIL",
    },
  ],
  [
    "china_phone",
    {
      // Matches the phone number body directly (lookaround replaces Go capture-group boundary style)
      pattern: String.raw`(?<!\d)1[3-9]\d{9}(?!\d)`,
      flags: "",
      category: "CHINA_PHONE",
    },
  ],
  [
    "china_id",
    {
      pattern: String.raw`(?<!\d)\d{17}[\dXx](?!\d)`,
      flags: "",
      category: "CHINA_ID",
    },
  ],
  [
    "uuid",
    {
      pattern: String.raw`[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}`,
      flags: "",
      category: "UUID",
    },
  ],
  [
    "ipv4",
    {
      // Does not validate 0-255 per octet; aims to cover common cases
      pattern: String.raw`(?:\d{1,3}\.){3}\d{1,3}`,
      flags: "",
      category: "IPV4",
    },
  ],
  [
    "mac",
    {
      pattern: String.raw`(?:[0-9a-f]{2}:){5}[0-9a-f]{2}`,
      flags: "i",
      category: "MAC",
    },
  ],
])

function compileRegexRule(pattern, flags, category, errors) {
  const peeled = peelInlineFlags(pattern, flags)
  const finalFlags = peeled.flags.includes("g") ? peeled.flags : `${peeled.flags}g`
  try {
    return { regex: new RegExp(peeled.pattern, finalFlags), category }
  } catch (error) {
    errors.push({
      pattern: peeled.pattern,
      flags: finalFlags,
      message: String(error?.message ?? error),
    })
    return null
  }
}

export function buildPatternSet(patterns) {
  const raw = patterns && typeof patterns === "object" ? patterns : {}

  const keywords = Array.isArray(raw.keywords) ? raw.keywords : []
  const regex = Array.isArray(raw.regex) ? raw.regex : []
  const builtin = Array.isArray(raw.builtin) ? raw.builtin : []
  const exclude = Array.isArray(raw.exclude) ? raw.exclude : []

  const keywordRules = keywords
    .map((x) => {
      if (!x || typeof x !== "object") return null
      const value = String(x.value ?? "").trim()
      if (!value) return null
      const category = sanitizeCategory(x.category)
      return { value, category }
    })
    .filter(Boolean)

  const regexRules = []
  const errors = []

  for (const x of regex) {
    if (!x || typeof x !== "object") continue
    const pattern = String(x.pattern ?? "").trim()
    if (!pattern) continue
    const category = sanitizeCategory(x.category)
    const flags = typeof x.flags === "string" ? x.flags : ""
    const rule = compileRegexRule(pattern, flags, category, errors)
    if (rule) regexRules.push(rule)
  }

  for (const name of builtin) {
    const key = String(name ?? "").trim()
    if (!key) continue
    const rule = BUILTIN.get(key)
    if (!rule) continue
    const compiled = compileRegexRule(rule.pattern, rule.flags, rule.category, errors)
    if (compiled) regexRules.push(compiled)
  }

  const excludeSet = new Set(exclude.map((x) => String(x ?? "")))

  return {
    keywords: keywordRules,
    regex: regexRules,
    exclude: excludeSet,
    errors,
  }
}
