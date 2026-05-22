# sai-trading-bot

TradingView → sai.fun (Nibiru perps).

Single entry point: a webhook server (`src/webhook.ts`) that receives TradingView alert POSTs and fires perp trades.

Built off the proven `openTrade` / `closeTrade` calls in `sai-website/webapp/state/web3Calls/trade.tsx`. The wallet must hold USDC on Nibiru. Gas is sponsored by the chain (`gasPrice=0`) for the PerpVaultEvmInterface contract.

> The `dev` branch carries additional surfaces (MCP server, Web UI manual trade form, CLI, TradingView strategy alert support, dynamic Pine sizing, step-by-step setup walkthrough, alternate payload variants). `main` is intentionally the minimal webhook-only build.

## Setup

```bash
cd ~/Code/sai-trading-bot
npm install
cp env.example.txt .env
# edit .env: set MNEMONIC and WEBHOOK_SECRET
```

## Run

```bash
# typecheck
npm run typecheck

# webhook server (dry-run)
npm run webhook:dry

# webhook server (live)
npm run webhook
```

The webhook server also serves a read-only monitoring dashboard at `/dashboard` (USDC balance, open positions, recent activity, dry-run / kill-switch controls, and a per-market alert-payload builder).

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

For `close`, provide the trade index:

```json
{ "secret": "...", "action": "close", "userTradeIndex": 42 }
```

## Security notes

- Run on a wallet funded with only the USDC you're comfortable risking.
- Use a TradingView Pro+ webhook URL only — TradingView's IPs are public, so always require `WEBHOOK_SECRET` and ideally put this behind a reverse proxy with IP allowlist.

## Chain config

Defaults to Nibiru Mainnet. Set `CHAIN=Testnet2` in `.env` to point at Testnet 2. Contract addresses live in `src/config.ts` (copied from `sai-website`).
