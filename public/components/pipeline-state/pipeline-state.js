/**
 * Pipeline state hero — the big MODE indicator at the top of the middle column.
 * Read-only; reflects state.killSwitch / state.dryRun / state.wallet.
 */

import { onState } from "/js/core.js"

export function init() {
  onState(render)
}

function render(s) {
  const pm = document.getElementById("pipeMode")
  if (!pm) return
  const mode = s.killSwitch ? "killed" : s.dryRun ? "dry" : "live"
  const modeLabel = s.killSwitch ? "KILLED" : s.dryRun ? "DRY-RUN" : "LIVE"
  pm.textContent = modeLabel
  pm.className = "mode " + mode

  document.getElementById("pipeSub").textContent =
    s.killSwitch ? "all trades blocked"
    : s.dryRun ? "simulating — no broadcast"
    : "trades broadcast live"
  document.getElementById("pipeAddr").textContent = s.wallet
}
