/**
 * In-memory ring buffer of recent trade events + runtime control flags
 * (dry-run, kill switch). Lost on restart — fine for v0.
 */

export type TradeEvent = {
  id: number
  ts: number // ms since epoch
  source: "webhook" | "mcp" | "cli" | "ui"
  action: "open_long" | "open_short" | "close" | "rejected"
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

export function recordEvent(e: Omit<TradeEvent, "id" | "ts">): TradeEvent {
  const full: TradeEvent = { id: nextId++, ts: Date.now(), ...e }
  buf.push(full)
  if (buf.length > MAX) buf.shift()
  return full
}

export function recentEvents(): TradeEvent[] {
  return buf.slice().reverse()
}

export function clearEvents(): void {
  buf.length = 0
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
