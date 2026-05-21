import { readFileSync } from "node:fs"
import { resolve } from "node:path"

/**
 * Tiny .env loader. Loads ./.env from the project root (cwd or this file's
 * parent dir, whichever has it first). Pre-existing process.env wins.
 */
export function loadDotenv(): void {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(__dirname, "..", ".env"),
  ]
  for (const path of candidates) {
    let raw: string
    try {
      raw = readFileSync(path, "utf8")
    } catch {
      continue
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      let value = stripInlineComment(trimmed.slice(eq + 1).trim())
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (process.env[key] === undefined) process.env[key] = value
    }
    return
  }
}

function stripInlineComment(value: string): string {
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0]
    for (let i = 1; i < value.length; i++) {
      if (value[i] === quote) return value.slice(0, i + 1)
    }
    return value
  }
  return value.replace(/\s+#.*$/, "").trim()
}
