/**
 * Cloudflare quick-tunnel manager.
 *
 * Spawns `cloudflared tunnel --url http://localhost:PORT` as a child process,
 * parses its log output for the trycloudflare.com URL, and exposes a tiny
 * lifecycle API the webhook server can call from /api/tunnel endpoints.
 *
 * Quick tunnels are ephemeral — every spawn gets a fresh random subdomain.
 * That's fine: the dashboard always reads the live URL from /api/state, and
 * the TV alert builder picks it up automatically.
 */

import { spawn, type ChildProcess } from "node:child_process"

export type TunnelStatus = "stopped" | "starting" | "running" | "error"

export type TunnelState = {
  status: TunnelStatus
  url: string | null
  error: string | null
  startedAt: number | null
}

let proc: ChildProcess | null = null
let state: TunnelState = { status: "stopped", url: null, error: null, startedAt: null }

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/
const START_TIMEOUT_MS = 20_000

export function getTunnelState(): TunnelState {
  return { ...state }
}

export function startTunnel(port: number): Promise<TunnelState> {
  if (proc && (state.status === "running" || state.status === "starting")) {
    return Promise.resolve({ ...state })
  }

  state = { status: "starting", url: null, error: null, startedAt: Date.now() }

  return new Promise((resolveOuter) => {
    let child: ChildProcess
    try {
      child = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], {
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (err) {
      state = { status: "error", url: null, error: (err as Error).message, startedAt: null }
      proc = null
      return resolveOuter({ ...state })
    }
    proc = child

    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      resolveOuter({ ...state })
    }

    const timer = setTimeout(() => {
      if (state.status === "starting") {
        state = { status: "error", url: null, error: "timeout waiting for tunnel URL", startedAt: null }
        try { child.kill() } catch {}
        proc = null
        settle()
      }
    }, START_TIMEOUT_MS)

    const handleChunk = (buf: Buffer | string) => {
      const text = buf.toString()
      if (state.status !== "starting") return
      const m = text.match(URL_RE)
      if (m) {
        clearTimeout(timer)
        state = { status: "running", url: m[0], error: null, startedAt: state.startedAt }
        settle()
      }
    }

    // cloudflared writes its banner to stderr by default; watch both streams.
    child.stdout?.on("data", handleChunk)
    child.stderr?.on("data", handleChunk)

    child.on("error", (err) => {
      clearTimeout(timer)
      state = { status: "error", url: null, error: err.message, startedAt: null }
      proc = null
      settle()
    })

    child.on("exit", (code, signal) => {
      clearTimeout(timer)
      const reason = signal ? `killed by ${signal}` : `exited code ${code ?? "?"}`
      proc = null
      if (state.status === "starting") {
        state = { status: "error", url: null, error: `cloudflared ${reason} before URL`, startedAt: null }
        settle()
      } else if (state.status === "running") {
        state = { status: "stopped", url: null, error: code ? `cloudflared ${reason}` : null, startedAt: null }
      }
    })
  })
}

export function stopTunnel(): TunnelState {
  if (proc) {
    try { proc.kill() } catch {}
    proc = null
  }
  state = { status: "stopped", url: null, error: null, startedAt: null }
  return { ...state }
}

// Ensure the child dies with us.
const shutdown = () => { try { stopTunnel() } catch {} }
process.on("SIGTERM", shutdown)
process.on("SIGINT", () => { shutdown(); process.exit(0) })
process.on("exit", shutdown)
