/**
 * Manual smoke test:
 *   tsx src/cli-open.ts <marketId> <long|short> <leverage> <amountUsdc> [slippagePct]
 *
 * Honors DRY_RUN=true in .env.
 */

import { loadDotenv } from "./env"
import { loadConfig } from "./config"
import { buildSigner } from "./wallet"
import { openTrade } from "./trade"

loadDotenv()

async function main() {
  const [marketIdRaw, side, leverageRaw, amountUsdc, slippageRaw] = process.argv.slice(2)
  if (!marketIdRaw || !side || !leverageRaw || !amountUsdc) {
    console.error("usage: tsx src/cli-open.ts <marketId> <long|short> <leverage> <amountUsdc> [slippagePct]")
    process.exit(2)
  }
  if (side !== "long" && side !== "short") {
    throw new Error("side must be 'long' or 'short'")
  }

  const app = loadConfig()
  const signer = buildSigner(app)

  const result = await openTrade(
    signer,
    {
      marketId: Number(marketIdRaw),
      long: side === "long",
      leverage: Number(leverageRaw),
      amountUsdc,
      slippagePct: slippageRaw ?? app.defaultSlippagePct,
    },
    { dryRun: app.dryRun, explorer: app.cfg.explorerTx },
  )

  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error("[error]", err)
  process.exit(1)
})
