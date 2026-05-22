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
import { listMarkets, findOpenTrade, type MarketSummary } from "./sai-keeper"
import { getTunnelState, startTunnel, stopTunnel } from "./tunnel"

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

// Flexible TradingView strategy alert — one payload routes both entries and
// exits. The bridge reads {{strategy.order.action}} and
// {{strategy.market_position}} placeholders and translates to the matching
// open/close call. Trim+lowercase before validating so whitespace and case
// from TV templates don't fail us.
const StrategyWebhookSchema = z.object({
  secret: z.string().min(1),
  action: z.literal("strategy"),
  marketId: z.number().int().nonnegative(),
  leverage: z.union([z.number(), z.string()]),
  amountUsdc: z.union([z.number(), z.string()]).transform((v) => String(v)),
  slippagePct: z
    .union([z.number(), z.string()])
    .optional()
    .transform((v) => (v === undefined ? undefined : String(v))),
  orderAction: z
    .string()
    .transform((s) => s.trim().toLowerCase())
    .pipe(z.enum(["buy", "sell"])),
  marketPosition: z
    .string()
    .transform((s) => s.trim().toLowerCase())
    .pipe(z.enum(["long", "short", "flat"])),
})

const WebhookSchema = z.union([
  OpenWebhookSchema,
  CloseByIndexWebhookSchema,
  StrategyWebhookSchema,
])

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

      if (body.action === "strategy") {
        // Translate (orderAction, marketPosition) → open_long | open_short |
        // close. See README for the truth table; reversals (buy while short
        // open, sell while long open) are treated as a fresh entry — operator
        // is expected to close manually or wire a separate close alert.
        const oa = body.orderAction
        const mp = body.marketPosition
        let translated: "open_long" | "open_short" | "close"
        let closeLong: boolean | null = null
        if (oa === "buy" && mp === "long") translated = "open_long"
        else if (oa === "sell" && mp === "short") translated = "open_short"
        else if (oa === "sell" && mp === "flat") { translated = "close"; closeLong = true }
        else if (oa === "buy" && mp === "flat") { translated = "close"; closeLong = false }
        else {
          recordEvent({
            source: "webhook",
            action: "rejected",
            marketId: body.marketId,
            status: "error",
            message: `strategy fill ambiguous: orderAction=${oa} marketPosition=${mp}`,
            durationMs: Date.now() - startedAt,
          })
          return res.status(400).json({
            error: "ambiguous_strategy_fill",
            orderAction: oa,
            marketPosition: mp,
          })
        }

        if (translated === "close") {
          const result = await closeTrade(
            signer,
            { marketId: body.marketId, long: closeLong as boolean },
            webhookTradeOpts("close", body.marketId),
          )
          recordEvent({
            source: "webhook",
            action: "close",
            marketId: body.marketId,
            status: result.status,
            txHash: result.txHash,
            explorer: result.explorer,
            message: `[strategy ${oa}/${mp}] ${result.message}`,
            durationMs: Date.now() - startedAt,
          })
          return res.json({ ...result, translatedFrom: { orderAction: oa, marketPosition: mp } })
        }

        // Reversal handling: if the opposite-side position is open in this
        // market, close it before opening the new side. Lets TV strategies in
        // Long/Short mode work without losing track of stacked positions, and
        // is a no-op for Long/Flat strategies (which never send a same-bar
        // reversal alert).
        const openingLong = translated === "open_long"
        const oppositeTrade = await findOpenTrade(
          app.cfg.saiKeeperEndpoint,
          signer.wallet.address,
          body.marketId,
          !openingLong,
        ).catch(() => null)

        let reversalClose: Awaited<ReturnType<typeof closeTrade>> | null = null
        if (oppositeTrade) {
          reversalClose = await closeTrade(
            signer,
            { userTradeIndex: oppositeTrade.userTradeIndex },
            webhookTradeOpts("reversal-close", body.marketId),
          )
          recordEvent({
            source: "webhook",
            action: "close",
            marketId: body.marketId,
            status: reversalClose.status,
            txHash: reversalClose.txHash,
            explorer: reversalClose.explorer,
            message: `[strategy ${oa}/${mp} reversal] closed opposite trade #${oppositeTrade.userTradeIndex}: ${reversalClose.message}`,
            durationMs: Date.now() - startedAt,
          })
        }

        const result = await openTrade(
          signer,
          {
            marketId: body.marketId,
            long: openingLong,
            leverage: body.leverage,
            amountUsdc: body.amountUsdc,
            slippagePct: body.slippagePct ?? app.defaultSlippagePct,
          },
          webhookTradeOpts(translated, body.marketId),
        )
        recordEvent({
          source: "webhook",
          action: translated,
          marketId: result.marketId,
          base: result.base,
          quote: result.quote,
          leverage: body.leverage,
          amountUsdc: body.amountUsdc,
          status: result.status,
          txHash: result.txHash,
          explorer: result.explorer,
          message: `[strategy ${oa}/${mp}${reversalClose ? " reversal" : ""}] ${result.message}`,
          durationMs: Date.now() - startedAt,
        })
        return res.json({
          ...result,
          translatedFrom: { orderAction: oa, marketPosition: mp },
          reversalClose: reversalClose ?? undefined,
        })
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
      const tunnel = getTunnelState()
      const tunnelWebhookUrl = tunnel.url ? `${tunnel.url}/webhook` : null
      res.json({
        chain: app.chain,
        wallet: signer.wallet.address,
        evmInterface: app.cfg.evmInterface,
        webhookUrl: tunnelWebhookUrl ?? app.publicWebhookUrl ?? `http://${app.bind}:${app.port}/webhook`,
        webhookUrlSource: tunnelWebhookUrl ? "tunnel" : app.publicWebhookUrl ? "env" : "local",
        tunnel,
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

  server.post("/api/tunnel/start", async (req, res) => {
    if (!checkSecret(req)) return res.status(403).json({ error: "forbidden" })
    const result = await startTunnel(app.port)
    res.json({ tunnel: result })
  })

  server.post("/api/tunnel/stop", (req, res) => {
    if (!checkSecret(req)) return res.status(403).json({ error: "forbidden" })
    const result = stopTunnel()
    res.json({ tunnel: result })
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
