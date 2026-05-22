/**
 * Ring buffer of recent trade events + runtime control flags (dry-run, kill
 * switch). Events are persisted to a JSONL file so the activity log survives
 * restarts; control flags are still memory-only (they re-read .env on boot).
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"

export type TradeEvent = {
  id: number
  ts: number // ms since epoch
  source: "webhook" | "mcp" | "cli" | "ui" | "strategy"
  action: "open_long" | "open_short" | "close" | "rejected" | "confirm" | "signal"
  /** For action="confirm", the original action whose tx is being confirmed
   *  (e.g. "close", "reversal-close", "open_long"). Lets the UI differentiate
   *  the two confirms from a strategy reversal. */
  confirmOf?: string
  marketId?: number
  base?: string
  quote?: string
  leverage?: number | string
  amountUsdc?: string
  status: "broadcast" | "dry-run" | "error" | "blocked"
  txHash?: string
  explorer?: string
  message: string
  durationMs?: number
}

const MAX = 50
const buf: TradeEvent[] = []
let nextId = 1
let logPath: string | null = null

export function initEventLog(path: string): void {
  logPath = path
  if (!existsSync(path)) return
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0)
  // Keep the last MAX events. Earlier lines stay in the file as history but
  // aren't rehydrated — the in-memory buffer caps at MAX.
  const tail = lines.slice(-MAX)
  for (const line of tail) {
    try {
      const ev = JSON.parse(line) as TradeEvent
      buf.push(ev)
      if (ev.id >= nextId) nextId = ev.id + 1
    } catch {
      // Skip malformed lines silently.
    }
  }
}

export function recordEvent(e: Omit<TradeEvent, "id" | "ts">): TradeEvent {
  const full: TradeEvent = { id: nextId++, ts: Date.now(), ...e }
  buf.push(full)
  if (buf.length > MAX) buf.shift()
  if (logPath) {
    try {
      appendFileSync(logPath, JSON.stringify(full) + "\n")
    } catch {
      // Persistence is best-effort; don't crash the request path.
    }
  }
  return full
}

export function recentEvents(): TradeEvent[] {
  return buf.slice().reverse()
}

export function clearEvents(): void {
  buf.length = 0
  if (logPath) {
    try {
      writeFileSync(logPath, "")
    } catch {
      // best-effort
    }
  }
}

let killSwitch = false

export function isKilled(): boolean {
  return killSwitch
}

export function setKilled(v: boolean): boolean {
  killSwitch = v
  return killSwitch
}

let dryRun = false

export function initDryRun(initial: boolean): void {
  dryRun = initial
}

export function isDryRun(): boolean {
  return dryRun
}

export function setDryRun(v: boolean): boolean {
  dryRun = v
  return dryRun
}
