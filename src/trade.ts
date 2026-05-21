import { ethers } from "ethers"
import { USDC_DECIMALS } from "./config"
import { fetchBorrowing, findOpenTrade } from "./sai-keeper"
import type { SignerCtx } from "./wallet"

const PERP_VAULT_EVM_ABI = [
  "function openTrade(bytes wasmMsgExecute, uint256 collateralIndex, uint256 tradeAmount, uint256 useERC20Amount)",
  "function executeSimpleFunctions(bytes wasmMsgExecute)",
]

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
]

export type OpenTradeArgs = {
  marketId: number
  long: boolean
  leverage: number | string
  amountUsdc: string // human units, e.g. "5"
  slippagePct?: string // percent, default "1"
}

export type TradeResult = {
  status: "broadcast" | "dry-run"
  txHash?: string
  explorer?: string
  marketId: number
  base: string
  quote: string
  openPrice?: number
  message: string
}

export async function openTrade(
  ctx: SignerCtx,
  args: OpenTradeArgs,
  opts: { dryRun?: boolean; explorer?: (h: string) => string } = {},
): Promise<TradeResult> {
  const { provider, wallet, cfg } = ctx
  const borrowing = await fetchBorrowing(cfg.saiKeeperEndpoint, args.marketId, cfg.usdcTokenIndex)
  if (!borrowing.isOpen) throw new Error(`Market ${args.marketId} is closed`)

  const base = borrowing.baseToken.symbol ?? borrowing.baseToken.name
  const quote = borrowing.quoteToken.symbol ?? borrowing.quoteToken.name

  const amount = ethers.parseUnits(args.amountUsdc, USDC_DECIMALS)
  const slippage = args.slippagePct ?? "1"

  // Balance check (best-effort; reverts will surface anyway).
  const usdc = new ethers.Contract(cfg.usdcEvm, ERC20_ABI, wallet)
  const balanceOf = usdc.getFunction("balanceOf")
  const erc20Balance: bigint = await balanceOf(wallet.address)
  if (erc20Balance < amount) {
    throw new Error(
      `Insufficient USDC: have ${ethers.formatUnits(erc20Balance, USDC_DECIMALS)}, need ${args.amountUsdc}`,
    )
  }

  const wasmMsg = {
    open_trade: {
      market_index: `MarketIndex(${args.marketId})`,
      leverage: String(args.leverage),
      long: args.long,
      collateral_index: `TokenIndex(${cfg.usdcTokenIndex})`,
      trade_type: "trade" as const,
      open_price: borrowing.price.toString(),
      tp: null,
      sl: null,
      slippage_p: String(slippage),
      is_evm_origin: true,
    },
  }
  const wasmMsgBytes = ethers.toUtf8Bytes(JSON.stringify(wasmMsg))

  const perpVault = new ethers.Contract(cfg.evmInterface, PERP_VAULT_EVM_ABI, wallet)
  const openFn = perpVault.getFunction("openTrade")

  let gasLimit: bigint
  try {
    const est = await openFn.estimateGas(
      wasmMsgBytes,
      cfg.usdcTokenIndex,
      amount,
      amount,
    )
    gasLimit = (est * 11n) / 10n
  } catch {
    gasLimit = 2_500_000n
  }

  if (opts.dryRun) {
    return {
      status: "dry-run",
      marketId: args.marketId,
      base,
      quote,
      openPrice: borrowing.price,
      message: `[dry-run] would openTrade ${args.long ? "LONG" : "SHORT"} ${base}/${quote} ` +
        `lev=${args.leverage} collateral=${args.amountUsdc} USDC slippage=${slippage}% gasLimit=${gasLimit}`,
    }
  }

  const tx = await openFn(
    wasmMsgBytes,
    cfg.usdcTokenIndex,
    amount,
    amount,
    { gasLimit, gasPrice: 0n },
  )
  const receipt = await tx.wait()
  if (receipt?.status !== 1) {
    throw new Error(`openTrade reverted (tx=${tx.hash})`)
  }

  return {
    status: "broadcast",
    txHash: tx.hash,
    explorer: opts.explorer?.(tx.hash),
    marketId: args.marketId,
    base,
    quote,
    openPrice: borrowing.price,
    message: `openTrade ${args.long ? "LONG" : "SHORT"} ${base}/${quote} broadcast: ${tx.hash}`,
  }
  // Suppress unused-warning for provider when tree-shaken; we only need it
  // attached to the wallet to actually broadcast.
  void provider
}

export type CloseTradeArgs =
  | { userTradeIndex: number }
  | { marketId: number; long: boolean }

export async function closeTrade(
  ctx: SignerCtx,
  args: CloseTradeArgs,
  opts: { dryRun?: boolean; explorer?: (h: string) => string } = {},
): Promise<TradeResult> {
  const { wallet, cfg } = ctx

  let userTradeIndex: number
  if ("userTradeIndex" in args) {
    userTradeIndex = args.userTradeIndex
  } else {
    const trade = await findOpenTrade(cfg.saiKeeperEndpoint, wallet.address, args.marketId, args.long)
    if (!trade) {
      throw new Error(
        `No open ${args.long ? "LONG" : "SHORT"} trade found for marketId=${args.marketId} on ${wallet.address}`,
      )
    }
    userTradeIndex = trade.userTradeIndex
  }

  const wasmMsg = {
    close_trade: {
      trade_index: `UserTradeIndex(${userTradeIndex.toFixed(0)})`,
    },
  }
  const wasmMsgBytes = ethers.toUtf8Bytes(JSON.stringify(wasmMsg))

  const perpVault = new ethers.Contract(cfg.evmInterface, PERP_VAULT_EVM_ABI, wallet)
  const closeFn = perpVault.getFunction("executeSimpleFunctions")

  let gasLimit: bigint
  try {
    const est = await closeFn.estimateGas(wasmMsgBytes)
    gasLimit = (est * 11n) / 10n
  } catch {
    gasLimit = 2_500_000n
  }

  if (opts.dryRun) {
    return {
      status: "dry-run",
      marketId: -1,
      base: "?",
      quote: "?",
      message: `[dry-run] would closeTrade userTradeIndex=${userTradeIndex} gasLimit=${gasLimit}`,
    }
  }

  const tx = await closeFn(wasmMsgBytes, { gasLimit, gasPrice: 0n })
  const receipt = await tx.wait()
  if (receipt?.status !== 1) {
    throw new Error(`closeTrade reverted (tx=${tx.hash})`)
  }

  return {
    status: "broadcast",
    txHash: tx.hash,
    explorer: opts.explorer?.(tx.hash),
    marketId: -1,
    base: "?",
    quote: "?",
    message: `closeTrade userTradeIndex=${userTradeIndex} broadcast: ${tx.hash}`,
  }
}
