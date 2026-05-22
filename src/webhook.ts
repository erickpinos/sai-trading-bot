/**
 * sai-trade-bridge HTTP server.
 *
 * Public:
 *   GET  /health             - liveness probe
 *   GET  /dashboard          - static dashboard UI
 *   GET  /api/state          - dashboard state
 *   GET  /api/markets        - open markets (cached 30s)
 *   POST /webhook            - TradingView alert receiver (auth: body.secret)
 *
 * UI-protected (auth: x-secret header):
 *   POST /api/open           - { long, marketId, leverage, amountUsdc, slippagePct? }
 *   POST /api/close          - { userTradeIndex } | { marketId, long }
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
import { openTrade, closeTrade, type CloseTradeArgs } from "./trade"
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

// `long` accepts a bool or a TradingView strategy placeholder string
// (`{{strategy.market_position_prev}}` resolves to "long" / "short" on a
// close fill). "true"/"false" are also accepted for raw JSON callers.
const CloseByMarketWebhookSchema = z.object({
  secret: z.string().min(1),
  action: z.literal("close"),
  marketId: z.number().int().nonnegative(),
  long: z.union([
    z.boolean(),
    z
      .string()
      .transform((s) => s.trim().toLowerCase())
      .pipe(z.enum(["long", "short", "true", "false"]))
      .transform((s) => s === "long" || s === "true"),
  ]),
})

// TradingView strategy alert — accepts raw {{strategy.order.action}} and
// {{strategy.market_position}} placeholders and translates to open/close.
// Trim+lowercase before validating so whitespace and case from TV templates
// don't fail us.
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
  CloseByMarketWebhookSchema,
  StrategyWebhookSchema,
])

const UiOpenSchema = z.object({
  long: z.boolean(),
  marketId: z.number().int().nonnegative(),
  leverage: z.union([z.number(), z.string()]),
  amountUsdc: z.union([z.number(), z.string()]).transform((v) => String(v)),
  slippagePct: z
    .union([z.number(), z.string()])
    .optional()
    .transform((v) => (v === undefined ? undefined : String(v))),
})

const UiCloseSchema = z.union([
  z.object({ userTradeIndex: z.number().int().nonnegative() }),
  z.object({ marketId: z.number().int().nonnegative(), long: z.boolean() }),
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
        const args: CloseTradeArgs =
          "userTradeIndex" in body
            ? { userTradeIndex: body.userTradeIndex }
            : { marketId: body.marketId, long: body.long }
        const result = await closeTrade(
          signer,
          args,
          webhookTradeOpts("close", "marketId" in body ? body.marketId : undefined),
        )
        recordEvent({
          source: "webhook",
          action: "close",
          marketId: "marketId" in body ? body.marketId : undefined,
          status: result.status,
          txHash: result.txHash,
          explorer: result.explorer,
          message: result.message,
          durationMs: Date.now() - startedAt,
        })
        return res.json(result)
      }

      if (body.action === "strategy") {
        // Translate (orderAction, marketPosition) → open_long | open_short | close.
        // See README for the truth table; reversals (sell+short, buy+long
        // while opposite was open) are treated as a fresh entry — operator
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

        const result = await openTrade(
          signer,
          {
            marketId: body.marketId,
            long: translated === "open_long",
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
          message: `[strategy ${oa}/${mp}] ${result.message}`,
          durationMs: Date.now() - startedAt,
        })
        return res.json({ ...result, translatedFrom: { orderAction: oa, marketPosition: mp } })
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
        mcp: { count: 0, lastTs: null, lastStatus: null },
        ui: { count: 0, lastTs: null, lastStatus: null },
        cli: { count: 0, lastTs: null, lastStatus: null },
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

  server.post("/api/open", async (req, res) => {
    if (!checkSecret(req)) return res.status(403).json({ error: "forbidden" })
    const startedAt = Date.now()
    try {
      const parsed = UiOpenSchema.safeParse(req.body)
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() })
      }
      const body = parsed.data

      if (isKilled()) {
        recordEvent({
          source: "ui",
          action: "rejected",
          status: "blocked",
          message: `kill switch engaged — rejected open`,
          durationMs: Date.now() - startedAt,
        })
        return res.status(503).json({ error: "kill_switch_engaged" })
      }

      const result = await openTrade(
        signer,
        {
          marketId: body.marketId,
          long: body.long,
          leverage: body.leverage,
          amountUsdc: body.amountUsdc,
          slippagePct: body.slippagePct ?? app.defaultSlippagePct,
        },
        tradeOpts(),
      )
      recordEvent({
        source: "ui",
        action: body.long ? "open_long" : "open_short",
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
      res.json(result)
    } catch (err) {
      const msg = (err as Error).message
      recordEvent({
        source: "ui",
        action: "rejected",
        status: "error",
        message: msg,
        durationMs: Date.now() - startedAt,
      })
      res.status(500).json({ error: "trade_failed", message: msg })
    }
  })

  server.post("/api/close", async (req, res) => {
    if (!checkSecret(req)) return res.status(403).json({ error: "forbidden" })
    const startedAt = Date.now()
    try {
      const parsed = UiCloseSchema.safeParse(req.body)
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid_payload", details: parsed.error.flatten() })
      }
      const body = parsed.data

      if (isKilled()) {
        recordEvent({
          source: "ui",
          action: "rejected",
          status: "blocked",
          message: `kill switch engaged — rejected close`,
          durationMs: Date.now() - startedAt,
        })
        return res.status(503).json({ error: "kill_switch_engaged" })
      }

      const args: CloseTradeArgs =
        "userTradeIndex" in body
          ? { userTradeIndex: body.userTradeIndex }
          : { marketId: body.marketId, long: body.long }
      const result = await closeTrade(signer, args, tradeOpts())
      recordEvent({
        source: "ui",
        action: "close",
        marketId: "marketId" in body ? body.marketId : undefined,
        status: result.status,
        txHash: result.txHash,
        explorer: result.explorer,
        message: result.message,
        durationMs: Date.now() - startedAt,
      })
      res.json(result)
    } catch (err) {
      const msg = (err as Error).message
      recordEvent({
        source: "ui",
        action: "rejected",
        status: "error",
        message: msg,
        durationMs: Date.now() - startedAt,
      })
      res.status(500).json({ error: "trade_failed", message: msg })
    }
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
