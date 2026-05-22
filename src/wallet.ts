import { ethers } from "ethers"
import { CHAINS, type AppConfig } from "./config"

export type SignerCtx = {
  provider: ethers.JsonRpcProvider
  wallet: ethers.BaseWallet
  cfg: (typeof CHAINS)[keyof typeof CHAINS]
}

export function buildSigner(app: AppConfig): SignerCtx {
  const provider = new ethers.JsonRpcProvider(app.cfg.evmRpc)
  let wallet: ethers.BaseWallet
  if (app.privateKey) {
    const key = app.privateKey.startsWith("0x") ? app.privateKey : `0x${app.privateKey}`
    wallet = new ethers.Wallet(key, provider)
  } else if (app.mnemonic) {
    wallet = ethers.HDNodeWallet.fromPhrase(
      app.mnemonic,
      undefined,
      app.derivationPath,
    ).connect(provider)
  } else {
    throw new Error("buildSigner: no MNEMONIC or PRIVATE_KEY available")
  }
  return { provider, wallet, cfg: app.cfg }
}
