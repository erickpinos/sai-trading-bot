/**
 * Manual smoke test:
 *   tsx src/cli-close.ts --index <userTradeIndex>
 *   tsx src/cli-close.ts --market <marketId> --side <long|short>
 *
 * Honors DRY_RUN=true in .env.
 */

import { loadDotenv } from "./env"
import { loadConfig } from "./config"
import { buildSigner } from "./wallet"
import { closeTrade, type CloseTradeArgs } from "./trade"

loadDotenv()

function parseArgs(argv: string[]): CloseTradeArgs {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]
    const v = argv[i + 1]
    if (!k || !v) break
    out[k.replace(/^--/, "")] = v
  }
  if (out.index !== undefined) return { userTradeIndex: Number(out.index) }
  if (out.market !== undefined && out.side !== undefined) {
    if (out.side !== "long" && out.side !== "short") throw new Error("side must be long|short")
    return { marketId: Number(out.market), long: out.side === "long" }
  }
  throw new Error("provide --index <n>  OR  --market <n> --side <long|short>")
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const app = loadConfig()
  const signer = buildSigner(app)
  const result = await closeTrade(signer, args, {
    dryRun: app.dryRun,
    explorer: app.cfg.explorerTx,
  })
  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error("[error]", err)
  process.exit(1)
})
