import { ethers } from "ethers"
import { CHAINS, type AppConfig } from "./config"

export type SignerCtx = {
  provider: ethers.JsonRpcProvider
  wallet: ethers.HDNodeWallet
  cfg: (typeof CHAINS)[keyof typeof CHAINS]
}

export function buildSigner(app: AppConfig): SignerCtx {
  const provider = new ethers.JsonRpcProvider(app.cfg.evmRpc)
  const wallet = ethers.HDNodeWallet.fromPhrase(
    app.mnemonic,
    undefined,
    app.derivationPath,
  ).connect(provider)
  return { provider, wallet, cfg: app.cfg }
}
