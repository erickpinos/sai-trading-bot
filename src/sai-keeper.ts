/**
 * Thin GraphQL client for the Sai keeper (sai.fun backend). Only the queries
 * we need to size orders and resolve user trades.
 */

import { evmToBech32 as evmToBech32Local } from "./bech32"

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

export type Borrowing = {
  isOpen: boolean
  marketId: number
  price: number
  minLeverage: number
  maxLeverage: number
  minPositionSizeUSD: number
  baseToken: { symbol: string | null; name: string }
  quoteToken: { symbol: string | null; name: string }
}

export async function fetchBorrowing(
  endpoint: string,
  marketId: number,
  collateralId: number,
): Promise<Borrowing> {
  const data = await gql<{ perp: { borrowing: Borrowing | null } | null }>(
    endpoint,
    `query {
      perp {
        borrowing(marketId: ${marketId}, collateralId: ${collateralId}) {
          isOpen marketId price minLeverage maxLeverage minPositionSizeUSD
          baseToken { symbol name }
          quoteToken { symbol name }
        }
      }
    }`,
  )
  const b = data.perp?.borrowing
  if (!b) throw new Error(`No borrowing for marketId=${marketId} collateralId=${collateralId}`)
  return b
}

export type MarketSummary = {
  marketId: number
  price: number
  isOpen: boolean
  base: string
  quote: string
  maxLeverage: number
}

export async function listMarkets(
  endpoint: string,
  // collateralId kept in the signature for backward compat — the borrowings
  // query returns one row per (marketId, collateral) pair so we just dedupe by
  // marketId. Sai exposes the same market across collaterals at the same price.
  _collateralId: number,
): Promise<MarketSummary[]> {
  type RawBorrowing = {
    marketId: number
    isOpen: boolean
    price: number
    maxLeverage: number
    baseToken: { symbol: string | null; name: string }
    quoteToken: { symbol: string | null; name: string }
  }
  const data = await gql<{ perp: { borrowings: RawBorrowing[] } | null }>(
    endpoint,
    `query { perp { borrowings {
      marketId isOpen price maxLeverage
      baseToken { symbol name }
      quoteToken { symbol name }
    } } }`,
  )
  const seen = new Set<number>()
  const out: MarketSummary[] = []
  for (const b of data.perp?.borrowings ?? []) {
    if (seen.has(b.marketId)) continue
    seen.add(b.marketId)
    if (!b.isOpen) continue
    out.push({
      marketId: b.marketId,
      price: b.price,
      isOpen: b.isOpen,
      base: b.baseToken.symbol ?? b.baseToken.name,
      quote: b.quoteToken.symbol ?? b.quoteToken.name,
      maxLeverage: b.maxLeverage,
    })
  }
  out.sort((a, b) => a.marketId - b.marketId)
  return out
}

export type UserTrade = {
  /** Same as `id` on PerpTrade — used as UserTradeIndex(N) in close_trade wasm msg. */
  userTradeIndex: number
  marketId: number
  long: boolean
  leverage: number
  collateralUsdc: number
  openPrice: number
}

/**
 * Resolve the user's open trade by a (marketId, long) selector — useful when a
 * TradingView "close" alert doesn't know the userTradeIndex.
 *
 * Uses `perp.trades(where: { trader, isOpen: true })` from the keeper schema.
 */
export async function findOpenTrade(
  endpoint: string,
  evmAddress: string,
  marketId: number,
  long: boolean,
): Promise<UserTrade | null> {
  const data = await gql<{
    perp: {
      trades: Array<{
        id: number
        isLong: boolean
        leverage: number
        collateralAmount: number
        openPrice: number
        perpBorrowing: { marketId: number }
      }>
    } | null
  }>(
    endpoint,
    `query OpenTrades($trader: String!) {
      perp {
        trades(where: { trader: $trader, isOpen: true }, limit: 100) {
          id
          isLong
          leverage
          collateralAmount
          openPrice
          perpBorrowing { marketId }
        }
      }
    }`,
    { trader: evmToBech32Local(evmAddress) },
  )
  const trades = data.perp?.trades ?? []
  const match = trades.find(
    (t) => t.perpBorrowing.marketId === marketId && t.isLong === long,
  )
  if (!match) return null
  return {
    userTradeIndex: match.id,
    marketId: match.perpBorrowing.marketId,
    long: match.isLong,
    leverage: match.leverage,
    collateralUsdc: match.collateralAmount / 1_000_000,
    openPrice: match.openPrice,
  }
}
