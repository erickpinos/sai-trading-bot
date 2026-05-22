/**
 * sai-trading-bot HTTP server.
 *
 * Public:
 *   GET  /health             - liveness probe
 *   GET  /dashboard          - static dashboard UI
 *   GET  /api/state          - dashboard state
 *   GET  /api/markets        - open markets (cached 30s)
 *   POST /webhook            - TradingView alert receiver (auth: body.secret)
 *
 * UI-protected (auth: x-secret header):
 *   POST /api/kill           - { engaged: boolean }
 *   POST /api/dry-run        - { enabled: boolean }
 *   POST /api/clear-events
 */

import { resolve } from "node:path"
import express, { type Request, type Response } from "express"
import { z } from "zod"
import { loadDotenv } from "./env"
import { loadConfig } from "./config"
import { buildSigner } from "./wallet"
import { openTrade, closeTrade } from "./trade"
import {
  recordEvent,
  recentEvents,
  clearEvents,
  isKilled,
  setKilled,
  isDryRun,
  setDryRun,
  initDryRun,
  initEventLog,
} from "./events"
import { getUsdcBalance, getOpenPositions } from "./positions"
import { listMarkets, type MarketSummary } from "./sai-keeper"

loadDotenv()

const OpenWebhookSchema = z.object({
  secret: z.string().min(1),
  action: z.enum(["open_long", "open_short"]),
  marketId: z.number().int().nonnegative(),
  leverage: z.union([z.number(), z.string()]),
  amountUsdc: z.union([z.number(), z.string()]).transform((v) => String(v)),
  slippagePct: z
    .union([z.number(), z.string()])
    .optional()
    .transform((v) => (v === undefined ? undefined : String(v))),
})

const CloseByIndexWebhookSchema = z.object({
  secret: z.string().min(1),
  action: z.literal("close"),
  userTradeIndex: z.number().int().nonnegative(),
})

const WebhookSchema = z.union([OpenWebhookSchema, CloseByIndexWebhookSchema])

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return mismatch === 0
}

async function main() {
  const app = loadConfig({ requireSecret: true })
  const signer = buildSigner(app)
  initDryRun(app.dryRun)
  initEventLog(resolve(process.cwd(), "events.jsonl"))

  console.log(`[boot] chain=${app.chain} wallet=${signer.wallet.address}`)
  console.log(`[boot] evmInterface=${app.cfg.evmInterface} dryRun=${app.dryRun}`)

  // 30s cache for markets — they don't change often, and the dashboard polls
  // /api/state every 5s. Refresh button in the UI bypasses by setting ?force=1.
  let marketsCache: { ts: number; data: MarketSummary[] } | null = null
  async function getMarkets(force = false): Promise<MarketSummary[]> {
    if (!force && marketsCache && Date.now() - marketsCache.ts < 30_000) {
      return marketsCache.data
    }
    const data = await listMarkets(app.cfg.saiKeeperEndpoint, app.cfg.usdcTokenIndex)
    marketsCache = { ts: Date.now(), data }
    return data
  }

  function checkSecret(req: Request): boolean {
    const secret = req.header("x-secret") ?? ""
    return timingSafeEqual(secret, app.webhookSecret)
  }

  function tradeOpts() {
    return { dryRun: isDryRun(), explorer: app.cfg.explorerTx }
  }

  // Webhook callers (TradingView) have ~3s timeout — too short to wait for
  // tx receipt on mainnet. Respond after broadcast, log receipt async.
  function webhookTradeOpts(action: string, marketId: number | undefined) {
    return {
      ...tradeOpts(),
      awaitReceipt: false as const,
      onTxBroadcast: (tx: { hash: string; wait: () => Promise<{ status?: number | null } | null> }) => {
        tx.wait()
          .then((r) => {
            const reverted = r?.status !== 1
            recordEvent({
              source: "webhook",
              action: "confirm",
              marketId,
              status: reverted ? "error" : "broadcast",
              txHash: tx.hash,
              explorer: app.cfg.explorerTx(tx.hash),
              message: reverted
                ? `tx ${tx.hash} reverted on-chain (${action})`
                : `tx ${tx.hash} confirmed (${action})`,
            })
          })
          .catch((err: Error) => {
            recordEvent({
              source: "webhook",
              action: "confirm",
              marketId,
              status: "error",
              txHash: tx.hash,
              explorer: app.cfg.explorerTx(tx.hash),
              message: `tx ${tx.hash} receipt error: ${err.message}`,
            })
          })
      },
    }
  }

  const server = express()
  server.use(express.json({ limit: "16kb" }))

  server.get("/health", (_req, res) => {
    res.json({
      ok: true,
      chain: app.chain,
      wallet: signer.wallet.address,
      dryRun: isDryRun(),
    })
  })

  // -------- TradingView webhook --------
  server.post("/webhook", async (req: Request, res: Response) => {
    const startedAt = Date.now()
    try {
      const parsed = WebhookSchema.safeParse(req.body)
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() })
      }
      const body = parsed.data

      if (!timingSafeEqual(body.secret, app.webhookSecret)) {
        return res.status(403).json({ error: "forbidden" })
      }

      if (isKilled()) {
        recordEvent({
          source: "webhook",
          action: "rejected",
          status: "blocked",
          message: `kill switch engaged — rejected ${body.action}`,
          durationMs: Date.now() - startedAt,
        })
        return res.status(503).json({ error: "kill_switch_engaged" })
      }

      if (body.action === "open_long" || body.action === "open_short") {
        const result = await openTrade(
          signer,
          {
            marketId: body.marketId,
            long: body.action === "open_long",
            leverage: body.leverage,
            amountUsdc: body.amountUsdc,
            slippagePct: body.slippagePct ?? app.defaultSlippagePct,
          },
          webhookTradeOpts(body.action, body.marketId),
        )
        recordEvent({
          source: "webhook",
          action: body.action,
          marketId: result.marketId,
          base: result.base,
          quote: result.quote,
          leverage: body.leverage,
          amountUsdc: body.amountUsdc,
          status: result.status,
          txHash: result.txHash,
          explorer: result.explorer,
          message: result.message,
          durationMs: Date.now() - startedAt,
        })
        return res.json(result)
      }

      if (body.action === "close") {
        const result = await closeTrade(
          signer,
          { userTradeIndex: body.userTradeIndex },
          webhookTradeOpts("close", undefined),
        )
        recordEvent({
          source: "webhook",
          action: "close",
          status: result.status,
          txHash: result.txHash,
          explorer: result.explorer,
          message: result.message,
          durationMs: Date.now() - startedAt,
        })
        return res.json(result)
      }

      return res.status(400).json({ error: "unknown_action" })
    } catch (err) {
      const msg = (err as Error).message
      recordEvent({
        source: "webhook",
        action: "rejected",
        status: "error",
        message: msg,
        durationMs: Date.now() - startedAt,
      })
      return res.status(500).json({ error: "trade_failed", message: msg })
    }
  })

  // -------- read endpoints --------
  server.get("/api/state", async (_req, res) => {
    try {
      const [balance, openRes] = await Promise.all([
        getUsdcBalance(signer).catch((e) => `error: ${(e as Error).message}`),
        getOpenPositions(signer),
      ])
      const events = recentEvents()
      const sources: Record<
        string,
        { count: number; lastTs: number | null; lastStatus: string | null }
      > = {
        webhook: { count: 0, lastTs: null, lastStatus: null },
      }
      for (const e of events) {
        const slot = sources[e.source]
        if (!slot) continue
        slot.count += 1
        if (slot.lastTs === null || e.ts > slot.lastTs) {
          slot.lastTs = e.ts
          slot.lastStatus = e.status
        }
      }
      res.json({
        chain: app.chain,
        wallet: signer.wallet.address,
        evmInterface: app.cfg.evmInterface,
        webhookUrl: app.publicWebhookUrl ?? `http://${app.bind}:${app.port}/webhook`,
        dryRun: isDryRun(),
        killSwitch: isKilled(),
        usdcBalance: balance,
        positions: openRes.positions,
        positionsWarning: openRes.warning,
        events,
        sources,
      })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  server.get("/api/markets", async (req, res) => {
    try {
      const force = req.query.force === "1"
      const data = await getMarkets(force)
      res.json({ markets: data })
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })

  // -------- UI-protected control endpoints --------
  server.post("/api/kill", (req, res) => {
    if (!checkSecret(req)) return res.status(403).json({ error: "forbidden" })
    const desired = Boolean((req.body as { engaged?: boolean })?.engaged)
    const now = setKilled(desired)
    console.log(`[kill] killSwitch=${now}`)
    res.json({ killSwitch: now })
  })

  server.post("/api/dry-run", (req, res) => {
    if (!checkSecret(req)) return res.status(403).json({ error: "forbidden" })
    const desired = Boolean((req.body as { enabled?: boolean })?.enabled)
    const now = setDryRun(desired)
    console.log(`[dryRun] ${now}`)
    res.json({ dryRun: now })
  })

  server.post("/api/clear-events", (req, res) => {
    if (!checkSecret(req)) return res.status(403).json({ error: "forbidden" })
    clearEvents()
    res.json({ cleared: true })
  })

  server.get("/dashboard", (_req, res) => {
    res.sendFile(resolve(__dirname, "..", "public", "dashboard.html"))
  })
  server.get("/", (_req, res) => res.redirect("/dashboard"))

  server.listen(app.port, app.bind, () => {
    console.log(`[ready] listening on http://${app.bind}:${app.port}`)
    console.log(`[ready] dashboard:  http://${app.bind}:${app.port}/dashboard`)
    console.log(`[ready] webhook:    POST http://${app.bind}:${app.port}/webhook`)
  })
}

main().catch((err) => {
  console.error("[fatal]", err)
  process.exit(1)
})
