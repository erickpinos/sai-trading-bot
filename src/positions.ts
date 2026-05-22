/**
 * Read-only helpers for the dashboard: USDC balance + open positions.
 *
 * Keeper schema: perp.trades(where: { trader, isOpen }) returning [PerpTrade!]!.
 * collateralAmount is Int in micro-USDC (1e6 scaling).
 */

import { ethers } from "ethers"
import { USDC_DECIMALS } from "./config"
import type { SignerCtx } from "./wallet"
import { evmToBech32 } from "./bech32"

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
  markPrice: number | null // current oracle price (from market borrowing)
  pnlUsdc: number | null // after-fees PnL in USDC (what you'd realize closing now)
  pnlPct: number | null // PnL as % of collateral
  feesUsdc: number | null // total fees in USDC (borrowing accrued + closing fee that'll be charged)
  borrowingFeeUsdc: number | null // accrued borrowing fee in USDC
  closingFeeUsdc: number | null // closing fee in USDC (charged when you close)
  liquidationPrice: number | null
  tp: number | null
  sl: number | null
  openedAt: string | null // ISO 8601 from openBlock.block_ts
}

type RawPerpTrade = {
  id: number
  isLong: boolean
  leverage: number
  collateralAmount: number
  openPrice: number
  tp: number | null
  sl: number | null
  state: {
    pnlCollateralAfterFees: number | null
    pnlPct: number | null
    borrowingFeeCollateral: number | null
    closingFeeCollateral: number | null
    liquidationPrice: number | null
  } | null
  openBlock: { block_ts: string } | null
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
      state {
        pnlCollateralAfterFees
        pnlPct
        borrowingFeeCollateral
        closingFeeCollateral
        liquidationPrice
      }
      openBlock { block_ts }
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
      { trader: evmToBech32(ctx.wallet.address) },
    )
    const raw = data.perp?.trades ?? []
    const SCALE = 10 ** USDC_DECIMALS
    const positions: OpenPosition[] = raw.map((t) => {
      // Sai keeper conventions: pnlCollateral* is in micro-collateral (1e6),
      // pnlPct is a fraction (0.05 = 5%), liquidationPrice is human units.
      const pnlPctFraction = t.state?.pnlPct ?? null
      const markPrice =
        pnlPctFraction !== null && t.leverage > 0
          ? t.openPrice * (1 + ((t.isLong ? 1 : -1) * pnlPctFraction) / t.leverage)
          : null
      return {
        id: t.id,
        marketId: t.perpBorrowing.marketId,
        base: t.perpBorrowing.baseToken.symbol ?? t.perpBorrowing.baseToken.name,
        quote: t.perpBorrowing.quoteToken.symbol ?? t.perpBorrowing.quoteToken.name,
        long: t.isLong,
        leverage: t.leverage,
        collateralUsdc: t.collateralAmount / SCALE,
        openPrice: t.openPrice,
        markPrice,
        pnlUsdc: t.state?.pnlCollateralAfterFees != null
          ? t.state.pnlCollateralAfterFees / SCALE
          : null,
        pnlPct: pnlPctFraction !== null ? pnlPctFraction * 100 : null,
        borrowingFeeUsdc: t.state?.borrowingFeeCollateral != null
          ? t.state.borrowingFeeCollateral / SCALE
          : null,
        closingFeeUsdc: t.state?.closingFeeCollateral != null
          ? t.state.closingFeeCollateral / SCALE
          : null,
        feesUsdc:
          t.state?.borrowingFeeCollateral != null && t.state?.closingFeeCollateral != null
            ? (t.state.borrowingFeeCollateral + t.state.closingFeeCollateral) / SCALE
            : null,
        liquidationPrice: t.state?.liquidationPrice ?? null,
        tp: t.tp,
        sl: t.sl,
        openedAt: t.openBlock?.block_ts ?? null,
      }
    })
    return { positions }
  } catch (e) {
    return {
      positions: [],
      warning: `keeper trades query failed: ${(e as Error).message}`,
    }
  }
}
