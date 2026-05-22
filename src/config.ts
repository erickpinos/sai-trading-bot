export type ChainType = "Mainnet" | "Testnet2"

export type ChainCfg = {
  evmRpc: string
  saiKeeperEndpoint: string
  evmInterface: string
  usdcEvm: string
  usdcTokenIndex: number
  explorerTx: (hash: string) => string
}

export const CHAINS: Record<ChainType, ChainCfg> = {
  Mainnet: {
    evmRpc: "https://evm-rpc.nibiru.fi",
    saiKeeperEndpoint: "https://sai-keeper.nibiru.fi/query",
    evmInterface: "0x9F48A925Dda8528b3A5c2A6717Df0F03c8b167c0",
    usdcEvm: "0x0829F361A05D993d5CEb035cA6DF3446b060970b",
    usdcTokenIndex: 1,
    explorerTx: (h) => `https://nibiscan.io/tx/${h}`,
  },
  Testnet2: {
    evmRpc: "https://evm-rpc.testnet-2.nibiru.fi",
    saiKeeperEndpoint: "https://sai-keeper.testnet-2.nibiru.fi/query",
    evmInterface: "0xC89Cd9fB1f2A77fAdCa62cCc4df21698cFFFaac9",
    usdcEvm: "0xAb68f1D1d91854383fd4Df9016E3040D03e8191a",
    usdcTokenIndex: 3,
    explorerTx: (h) => `https://testnet.nibiscan.io/tx/${h}`,
  },
}

export const USDC_DECIMALS = 6

function envOr(key: string, fallback: string): string {
  const v = process.env[key]
  return v === undefined || v === "" ? fallback : v
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key]?.toLowerCase()
  if (v === undefined || v === "") return fallback
  return v === "true" || v === "1" || v === "yes"
}

export type AppConfig = {
  chain: ChainType
  cfg: ChainCfg
  mnemonic: string | null
  privateKey: string | null
  derivationPath: string
  defaultSlippagePct: string
  dryRun: boolean
  webhookSecret: string
  port: number
  bind: string
  publicWebhookUrl: string | null
}

export function loadConfig(opts?: { requireSecret?: boolean }): AppConfig {
  const chain = envOr("CHAIN", "Mainnet") as ChainType
  if (!(chain in CHAINS)) {
    throw new Error(`Invalid CHAIN=${chain} (use Mainnet or Testnet2)`)
  }
  const baseCfg = CHAINS[chain]
  const cfg: ChainCfg = {
    ...baseCfg,
    evmRpc: envOr("EVM_RPC", baseCfg.evmRpc),
    saiKeeperEndpoint: envOr("SAI_KEEPER_ENDPOINT", baseCfg.saiKeeperEndpoint),
  }
  const mnemonic = process.env.MNEMONIC?.trim() || null
  const privateKey = process.env.PRIVATE_KEY?.trim() || null
  if (!mnemonic && !privateKey) {
    throw new Error("Set MNEMONIC or PRIVATE_KEY in .env")
  }
  if (mnemonic && privateKey) {
    throw new Error("Set only one of MNEMONIC or PRIVATE_KEY in .env, not both")
  }

  const webhookSecret = process.env.WEBHOOK_SECRET ?? ""
  if (opts?.requireSecret && !webhookSecret) {
    throw new Error("WEBHOOK_SECRET missing from .env (required for webhook server)")
  }

  return {
    chain,
    cfg,
    mnemonic,
    privateKey,
    derivationPath: envOr("DERIVATION_PATH", "m/44'/60'/0'/0/0"),
    defaultSlippagePct: envOr("DEFAULT_SLIPPAGE_PCT", "1"),
    dryRun: envBool("DRY_RUN", false),
    webhookSecret,
    port: Number(envOr("PORT", "3030")),
    bind: envOr("BIND", "127.0.0.1"),
    publicWebhookUrl: process.env.PUBLIC_WEBHOOK_URL?.trim() || null,
  }
}
