# sai-trade-bridge

TradingView + MCP → sai.fun (Nibiru perps).

Two entry points to the same Sai trade core:

1. **Webhook server** (`src/webhook.ts`) — receives TradingView alert POSTs and fires perp trades.
2. **MCP server** (`src/mcp.ts`) — exposes the same trade actions as tools so Claude / Cursor / any MCP client can trade.

Built off the proven `openTrade` / `closeTrade` calls in `sai-website/webapp/state/web3Calls/trade.tsx`. The wallet must hold USDC on Nibiru. Gas is sponsored by the chain (`gasPrice=0`) for the PerpVaultEvmInterface contract.

## Setup

```bash
cd ~/Code/sai-trade-bridge
npm install
cp env.example.txt .env
# edit .env: set MNEMONIC and WEBHOOK_SECRET
```

## Run

```bash
# typecheck
npm run typecheck

# dry-run open long, 2x leverage, $5 collateral, market 1
DRY_RUN=true npx tsx src/cli-open.ts 1 long 2 5

# webhook server (dry-run)
DRY_RUN=true npm run webhook:dry

# webhook server (live)
npm run webhook

# MCP server (stdio — wire into Claude Desktop / Code config)
npm run mcp
```

## TradingView alert format

In your TradingView alert, set webhook URL to `http://<host>:3030/webhook` and message body to JSON:

```json
{
  "secret": "your-WEBHOOK_SECRET",
  "action": "open_long",
  "marketId": 1,
  "leverage": 2,
  "amountUsdc": "5",
  "slippagePct": "1"
}
```

Actions: `open_long`, `open_short`, `close`.

For `close`, provide either:

```json
{ "secret": "...", "action": "close", "userTradeIndex": 42 }
```

or — let the bridge resolve the trade index from the keeper:

```json
{ "secret": "...", "action": "close", "marketId": 1, "long": true }
```

## MCP wiring (Claude Desktop / Claude Code)

Add to your MCP config:

```json
{
  "mcpServers": {
    "sai": {
      "command": "npx",
      "args": ["tsx", "/Users/Erick/Code/sai-trade-bridge/src/mcp.ts"]
    }
  }
}
```

Exposed tools:

- `open_long(marketId, leverage, amountUsdc, slippagePct?)`
- `open_short(marketId, leverage, amountUsdc, slippagePct?)`
- `close_trade(userTradeIndex)`  *or*  `close_trade(marketId, long)`
- `list_markets()`
- `get_wallet()`

## Security notes

- Run on a wallet funded with only the USDC you're comfortable risking.
- Use a TradingView Pro+ webhook URL only — TradingView's IPs are public, so always require `WEBHOOK_SECRET` and ideally put this behind a reverse proxy with IP allowlist.
- LLM-triggered trades through MCP have *zero* sanity bound by default. Add max-size / max-leverage guards in `trade.ts` if you wire this to an autonomous agent.

## Chain config

Defaults to Nibiru Mainnet. Set `CHAIN=Testnet2` in `.env` to point at Testnet 2. Contract addresses live in `src/config.ts` (copied from `sai-website`).
