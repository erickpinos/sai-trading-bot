# sai-trading-bot

**Non-custodial TradingView → [sai.fun](https://sai.fun) perps bridge.** Self-hosted webhook server that turns TradingView alerts into perp trades on Nibiru. Your wallet, your machine, your trades.

<!-- TODO: replace REPO_OWNER below with your GitHub username before publishing -->

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node 22+](https://img.shields.io/badge/Node-22%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Non-custodial](https://img.shields.io/badge/wallet-non--custodial-2ea44f)](#security--threat-model)

<!-- TODO: add a dashboard screenshot or short demo GIF here -->

## What it does

- Listens for TradingView webhook alerts and signs Sai perp trades on Nibiru EVM.
- Read-only dashboard at `/dashboard`: USDC balance, open positions, recent activity, kill-switch, dry-run toggle, per-market alert-payload builder.
- Built-in Cloudflare Tunnel manager so you don't need a public IP or static DNS to receive alerts.
- Runs on plain Node — no database, no external services beyond the chain RPC and Sai's keeper.
- Mainnet and Testnet2 supported via one env var.

## Quickstart

Requires Node 22+ (or Bun). Fund a fresh EVM wallet with USDC on Nibiru first.

```bash
git clone https://github.com/REPO_OWNER/sai-trading-bot.git
cd sai-trading-bot
npm install
cp env.example.txt .env
# edit .env: set EITHER MNEMONIC (seed phrase) OR PRIVATE_KEY,
# and set WEBHOOK_SECRET to a long random string

npm run webhook:dry   # simulate trades, no broadcasts
npm run webhook       # live
```

Open `http://127.0.0.1:3030/dashboard` to see the bot's state. Point TradingView alerts at `http://<your-host>:3030/webhook`.

## Deploy

### Docker

```bash
docker build -t sai-trading-bot .
docker run --rm -p 3030:3030 --env-file .env sai-trading-bot
```

### One-click

<!-- TODO: replace REPO_OWNER with your GitHub username after publishing -->

- **Railway:** [![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https%3A%2F%2Fgithub.com%2FREPO_OWNER%2Fsai-trading-bot)
- **Fly.io:** `fly launch --from https://github.com/REPO_OWNER/sai-trading-bot`

Set `MNEMONIC` (or `PRIVATE_KEY`), `WEBHOOK_SECRET`, and (recommended) `BIND=0.0.0.0` in the host's environment. Don't paste secrets into CLI flags — use the platform's secret store.

### Self-host with the built-in tunnel

The bot ships with a Cloudflare Tunnel manager (`src/tunnel.ts`). Run the bot locally, click "Start tunnel" in the dashboard, and TradingView gets a public HTTPS URL pointing at your laptop. No port-forwarding, no domain, no cloud provider.

## Security & threat model

**This is a hot-signing bot. Read this before funding the wallet.**

What the bot needs to function:

- A wallet mnemonic *or* private key on disk in `.env`, loaded into memory at startup.
- A network listener that accepts trade instructions from TradingView (or anyone who can reach the URL).

What that implies:

| Failure mode | Consequence | Mitigation |
|---|---|---|
| Server / box compromise | Attacker reads the mnemonic or private key, drains the wallet on any chain that key controls. | Use a **dedicated** wallet funded only with your trading float. Never reuse a personal seed or key. Never run this on a shared machine. |
| `WEBHOOK_SECRET` leaks (logs, screenshots, accidental commits) | Anyone with the secret can forge alerts and open trades. | Treat the secret like a password. Rotate it. Don't paste alert JSON anywhere public. Add IP allowlisting via reverse proxy if exposed publicly. |
| Buggy strategy or flipped sign in your Pine script | Bot opens losing positions on demand. | Run `npm run webhook:dry` first. Watch the dashboard. Use small position sizes. |
| RPC / Sai keeper outage | Trades fail; bot returns errors. | No funds at risk, but expect dropped alerts during outages. Set `EVM_RPC` to a dedicated provider if running serious size. |

**The bot does not currently enforce per-trade spend caps, market allowlists, or daily volume limits.** A leaked `WEBHOOK_SECRET` plus zero caps is a single-step drain path. If you're funding the wallet with more than you'd accept losing, add these guardrails in `src/trade.ts` before going live.

### How to audit before trusting it

The bot is intentionally small. The files that touch keys, sign transactions, or accept external input:

- [`src/wallet.ts`](./src/wallet.ts) — mnemonic / private key → signer.
- [`src/trade.ts`](./src/trade.ts) — the `openTrade` / `closeTrade` calls. This is what gets signed.
- [`src/webhook.ts`](./src/webhook.ts) — HTTP routes, secret check, request routing.
- [`src/sai-keeper.ts`](./src/sai-keeper.ts) — read-only GraphQL queries against Sai.
- [`src/config.ts`](./src/config.ts) — chain endpoints, contract addresses. All network targets live here.

No other file makes outbound network calls. No telemetry. No analytics. No code is fetched at runtime.

## TradingView alert format

Webhook URL: `http://<your-host>:3030/webhook`. Message body (JSON):

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

For `close`, pass the trade index:

```json
{ "secret": "...", "action": "close", "userTradeIndex": 42 }
```

### Flexible strategy alert (one message, all signals)

Use `action: "strategy"` to route entries and exits from a single TradingView alert by passing TV's strategy variables through:

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

Translation:

| orderAction | marketPosition | resolved action |
|-------------|----------------|-----------------|
| buy         | long           | open_long       |
| sell        | short          | open_short      |
| sell        | flat           | close (the open long) |
| buy         | flat           | close (the open short) |

Set the alert *Condition* to your Pine strategy with *Order fills only*. Reversals (e.g. `sell` while long without first flattening) fire as fresh entries — wire a separate close alert if your strategy needs flip-on-signal behavior.

## Configuration

| Env var | Default | Notes |
|---|---|---|
| `MNEMONIC` | *(required if no `PRIVATE_KEY`)* | 12/24-word BIP-39 seed. Use a dedicated wallet. |
| `PRIVATE_KEY` | *(required if no `MNEMONIC`)* | 64-char hex private key (with or without `0x` prefix). Mutually exclusive with `MNEMONIC`. |
| `WEBHOOK_SECRET` | *(required for webhook)* | Long random string. Rotate regularly. |
| `CHAIN` | `Mainnet` | `Mainnet` or `Testnet2`. |
| `EVM_RPC` | chain default | Override the chain's RPC. Use a dedicated provider for production. |
| `SAI_KEEPER_ENDPOINT` | chain default | Override the Sai keeper GraphQL endpoint. |
| `DERIVATION_PATH` | `m/44'/60'/0'/0/0` | BIP-44 path. |
| `DEFAULT_SLIPPAGE_PCT` | `1` | Slippage tolerance, percent. |
| `DRY_RUN` | `false` | `true` simulates without broadcasting. |
| `PORT` | `3030` | HTTP port. |
| `BIND` | `127.0.0.1` | Use `0.0.0.0` for container / hosted deploys. |
| `PUBLIC_WEBHOOK_URL` | *(unset)* | Public URL shown in the dashboard (e.g. tunnel URL). |

## License

[MIT](./LICENSE). No warranty. You are responsible for the trades this bot makes on your behalf.
