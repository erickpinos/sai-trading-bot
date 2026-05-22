# sai-trading-bot

TradingView → sai.fun (Nibiru perps).

Single entry point: a webhook server (`src/webhook.ts`) that receives TradingView alert POSTs and fires perp trades.

Built off the proven `openTrade` / `closeTrade` calls in `sai-website/webapp/state/web3Calls/trade.tsx`. The wallet must hold USDC on Nibiru. Gas is sponsored by the chain (`gasPrice=0`) for the PerpVaultEvmInterface contract.

> The `dev` branch carries additional surfaces (MCP server, Web UI manual trade form, CLI, dynamic Pine sizing, step-by-step setup walkthrough, alternate payload variants). `main` is the minimal webhook-only build with both per-action payloads and the flexible strategy alert.

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

Actions: `open_long`, `open_short`, `close`, `strategy`.

For `close`, provide the trade index:

```json
{ "secret": "...", "action": "close", "userTradeIndex": 42 }
```

### Flexible strategy alert (one message, all signals)

If you'd rather use a single TradingView alert that routes both entries and exits, use `action: "strategy"` and let the bridge translate `{{strategy.order.action}}` + `{{strategy.market_position}}` into the right call:

```json
{
  "secret": "your-WEBHOOK_SECRET",
  "action": "strategy",
  "marketId": 1,
  "leverage": 2,
  "amountUsdc": "5",
  "slippagePct": "1",
  "orderAction": "{{strategy.order.action}}",
  "marketPosition": "{{strategy.market_position}}"
}
```

Translation table (TV `orderAction` / `marketPosition` → bridge action):

| orderAction | marketPosition | action |
|-------------|----------------|--------|
| buy         | long           | open_long |
| sell        | short          | open_short |
| sell        | flat           | close (the open long) |
| buy         | flat           | close (the open short) |

Set the alert *Condition* to your Pine strategy with *Order fills only*. Reversals (e.g. `sell` while a long is open without first flattening) are not auto-flipped; they fire as a fresh entry — wire a separate close alert if your strategy needs that.

## Security notes

- Run on a wallet funded with only the USDC you're comfortable risking.
- Use a TradingView Pro+ webhook URL only — TradingView's IPs are public, so always require `WEBHOOK_SECRET` and ideally put this behind a reverse proxy with IP allowlist.

## Chain config

Defaults to Nibiru Mainnet. Set `CHAIN=Testnet2` in `.env` to point at Testnet 2. Contract addresses live in `src/config.ts` (copied from `sai-website`).
