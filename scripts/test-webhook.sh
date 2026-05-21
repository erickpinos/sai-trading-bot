#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

set -a
# shellcheck disable=SC1091
source .env
set +a

: "${WEBHOOK_SECRET:?WEBHOOK_SECRET missing from .env}"

URL="${1:-${PUBLIC_WEBHOOK_URL:-http://127.0.0.1:${PORT:-3030}/webhook}}"
ACTION="${2:-open_long}"
MARKET_ID="${3:-0}"
LEVERAGE="${4:-5}"
AMOUNT="${5:-25}"

if [[ "$ACTION" == "close" ]]; then
  PAYLOAD=$(printf '{"secret":"%s","action":"close","marketId":%s,"long":true}' "$WEBHOOK_SECRET" "$MARKET_ID")
else
  PAYLOAD=$(printf '{"secret":"%s","action":"%s","marketId":%s,"leverage":%s,"amountUsdc":%s}' \
    "$WEBHOOK_SECRET" "$ACTION" "$MARKET_ID" "$LEVERAGE" "$AMOUNT")
fi

echo "POST $URL"
echo "  action=$ACTION marketId=$MARKET_ID leverage=$LEVERAGE amountUsdc=$AMOUNT"
echo

curl -sS -i -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD"
echo
