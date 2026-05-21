/**
 * MCP server exposing Sai trade tools.
 *
 * Run via stdio (e.g. add to Claude Desktop / Claude Code MCP config). Tools:
 *   - open_long
 *   - open_short
 *   - close_trade
 *   - list_markets
 *   - get_wallet
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { loadDotenv } from "./env"
import { loadConfig } from "./config"
import { buildSigner } from "./wallet"
import { openTrade, closeTrade } from "./trade"
import { listMarkets } from "./sai-keeper"

loadDotenv()

const TOOLS = [
  {
    name: "open_long",
    description: "Open a LONG perp position on sai.fun using USDC collateral.",
    inputSchema: {
      type: "object",
      properties: {
        marketId: { type: "number", description: "Sai market id (use list_markets to discover)" },
        leverage: { type: "number", description: "Integer leverage, e.g. 2, 5, 10" },
        amountUsdc: { type: "string", description: "Collateral in USDC (human units), e.g. \"5\"" },
        slippagePct: { type: "string", description: "Slippage tolerance percent, default 1" },
      },
      required: ["marketId", "leverage", "amountUsdc"],
    },
  },
  {
    name: "open_short",
    description: "Open a SHORT perp position on sai.fun using USDC collateral.",
    inputSchema: {
      type: "object",
      properties: {
        marketId: { type: "number" },
        leverage: { type: "number" },
        amountUsdc: { type: "string" },
        slippagePct: { type: "string" },
      },
      required: ["marketId", "leverage", "amountUsdc"],
    },
  },
  {
    name: "close_trade",
    description:
      "Close an open trade. Provide either userTradeIndex, or (marketId + long) to resolve the index from the keeper.",
    inputSchema: {
      type: "object",
      properties: {
        userTradeIndex: { type: "number" },
        marketId: { type: "number" },
        long: { type: "boolean" },
      },
    },
  },
  {
    name: "list_markets",
    description: "List open markets on sai.fun with current price.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_wallet",
    description: "Get the configured EVM wallet address and chain.",
    inputSchema: { type: "object", properties: {} },
  },
] as const

async function main() {
  const app = loadConfig()
  const signer = buildSigner(app)

  const server = new Server(
    { name: "sai-trade-bridge", version: "0.1.0" },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params
    const args = (rawArgs ?? {}) as Record<string, unknown>

    try {
      switch (name) {
        case "get_wallet": {
          return text({
            chain: app.chain,
            wallet: signer.wallet.address,
            evmInterface: app.cfg.evmInterface,
            dryRun: app.dryRun,
          })
        }

        case "list_markets": {
          const markets = await listMarkets(app.cfg.saiKeeperEndpoint, app.cfg.usdcTokenIndex)
          return text(markets)
        }

        case "open_long":
        case "open_short": {
          const marketId = num(args.marketId, "marketId")
          const leverage = num(args.leverage, "leverage")
          const amountUsdc = str(args.amountUsdc, "amountUsdc")
          const slippagePct =
            args.slippagePct === undefined ? app.defaultSlippagePct : String(args.slippagePct)
          const result = await openTrade(
            signer,
            { marketId, long: name === "open_long", leverage, amountUsdc, slippagePct },
            { dryRun: app.dryRun, explorer: app.cfg.explorerTx },
          )
          return text(result)
        }

        case "close_trade": {
          let result
          if (args.userTradeIndex !== undefined) {
            result = await closeTrade(
              signer,
              { userTradeIndex: num(args.userTradeIndex, "userTradeIndex") },
              { dryRun: app.dryRun, explorer: app.cfg.explorerTx },
            )
          } else if (args.marketId !== undefined && args.long !== undefined) {
            result = await closeTrade(
              signer,
              { marketId: num(args.marketId, "marketId"), long: Boolean(args.long) },
              { dryRun: app.dryRun, explorer: app.cfg.explorerTx },
            )
          } else {
            throw new Error("close_trade requires either userTradeIndex or (marketId + long)")
          }
          return text(result)
        }

        default:
          throw new Error(`unknown tool: ${name}`)
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
        isError: true,
      }
    }
  })

  function text(payload: unknown) {
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    }
  }

  function num(v: unknown, field: string): number {
    if (typeof v === "number") return v
    if (typeof v === "string" && v !== "" && !Number.isNaN(Number(v))) return Number(v)
    throw new Error(`${field} must be a number`)
  }

  function str(v: unknown, field: string): string {
    if (typeof v === "string" && v !== "") return v
    if (typeof v === "number") return String(v)
    throw new Error(`${field} must be a string`)
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)
  // Log to stderr only — stdout is the MCP transport.
  console.error(`[sai-mcp] ready chain=${app.chain} wallet=${signer.wallet.address}`)
}

main().catch((err) => {
  console.error("[fatal]", err)
  process.exit(1)
})
