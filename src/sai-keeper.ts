/**
 * Thin GraphQL client for the Sai keeper (sai.fun backend). Only the queries
 * we need to size orders and resolve user trades.
 */

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
}

export async function listMarkets(
  endpoint: string,
  collateralId: number,
): Promise<MarketSummary[]> {
  // We don't have an introspection-guaranteed list query, so scan marketIds
  // 0..30 and keep open ones. This is cheap and matches how the webapp
  // populates its market dropdown.
  const out: MarketSummary[] = []
  for (let id = 0; id < 30; id++) {
    try {
      const b = await fetchBorrowing(endpoint, id, collateralId)
      if (b.isOpen) {
        out.push({
          marketId: b.marketId,
          price: b.price,
          isOpen: b.isOpen,
          base: b.baseToken.symbol ?? b.baseToken.name,
          quote: b.quoteToken.symbol ?? b.quoteToken.name,
        })
      }
    } catch {
      // skip
    }
  }
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
    { trader: evmAddress.toLowerCase() },
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
