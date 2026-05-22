/** USDC balance for the bot wallet — read-only. */

import { onState, fmt } from "/js/core.js"

export function init() { onState(render) }

function render(s) {
  const balEl = document.getElementById("balance")
  const isErr = typeof s.usdcBalance === "string" && s.usdcBalance.startsWith("error:")
  balEl.textContent = isErr ? "—" : (Number(s.usdcBalance).toFixed(2) + " USDC")
  document.getElementById("balanceLabel").textContent = fmt.addr(s.wallet)
}
