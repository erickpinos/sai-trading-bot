/**
 * Read-only helpers for the dashboard: USDC balance + open positions.
 *
 * Keeper schema: perp.trades(where: { trader, isOpen }) returning [PerpTrade!]!.
 * collateralAmount is Int in micro-USDC (1e6 scaling).
 */

import { ethers } from "ethers"
import { USDC_DECIMALS } from "./config"
import type { SignerCtx } from "./wallet"

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"]

export async function getUsdcBalance(ctx: SignerCtx): Promise<string> {
  const usdc = new ethers.Contract(ctx.cfg.usdcEvm, ERC20_ABI, ctx.wallet)
  const balanceOf = usdc.getFunction("balanceOf")
  const raw: bigint = await balanceOf(ctx.wallet.address)
  return ethers.formatUnits(raw, USDC_DECIMALS)
}

export type OpenPosition = {
  id: number // = userTradeIndex for close_trade
  marketId: number
  base: string
  quote: string
  long: boolean
  leverage: number
  collateralUsdc: number
  openPrice: number
  tp: number | null
  sl: number | null
}

type RawPerpTrade = {
  id: number
  isLong: boolean
  leverage: number
  collateralAmount: number
  openPrice: number
  tp: number | null
  sl: number | null
  perpBorrowing: {
    marketId: number
    baseToken: { symbol: string | null; name: string }
    quoteToken: { symbol: string | null; name: string }
  }
}

async function gql<T>(endpoint: string, query: string, variables?: object): Promise<T> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`sai-keeper ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as { data?: T; errors?: unknown }
  if (json.errors) throw new Error(`sai-keeper GraphQL errors: ${JSON.stringify(json.errors)}`)
  if (!json.data) throw new Error("sai-keeper: no data")
  return json.data
}

const OPEN_TRADES_QUERY = `query OpenTrades($trader: String!) {
  perp {
    trades(where: { trader: $trader, isOpen: true }, limit: 100) {
      id
      isLong
      leverage
      collateralAmount
      openPrice
      tp
      sl
      perpBorrowing {
        marketId
        baseToken { symbol name }
        quoteToken { symbol name }
      }
    }
  }
}`

export async function getOpenPositions(ctx: SignerCtx): Promise<{
  positions: OpenPosition[]
  warning?: string
}> {
  try {
    const data = await gql<{ perp: { trades: RawPerpTrade[] } | null }>(
      ctx.cfg.saiKeeperEndpoint,
      OPEN_TRADES_QUERY,
      { trader: ctx.wallet.address.toLowerCase() },
    )
    const raw = data.perp?.trades ?? []
    const positions: OpenPosition[] = raw.map((t) => ({
      id: t.id,
      marketId: t.perpBorrowing.marketId,
      base: t.perpBorrowing.baseToken.symbol ?? t.perpBorrowing.baseToken.name,
      quote: t.perpBorrowing.quoteToken.symbol ?? t.perpBorrowing.quoteToken.name,
      long: t.isLong,
      leverage: t.leverage,
      collateralUsdc: t.collateralAmount / 10 ** USDC_DECIMALS,
      openPrice: t.openPrice,
      tp: t.tp,
      sl: t.sl,
    }))
    return { positions }
  } catch (e) {
    return {
      positions: [],
      warning: `keeper trades query failed: ${(e as Error).message}`,
    }
  }
}
