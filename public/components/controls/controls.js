/**
 * Kill switch + dry-run toggle. Both mutate server state via POST and then
 * trigger a state refresh so every other component re-renders coherently.
 */

import { onState, auth, refreshState, getState } from "/js/core.js"

export function init() {
  document.getElementById("killBtn").addEventListener("click", async () => {
    const s = getState()
    if (!s) return
    const res = await auth("/api/kill", { engaged: !s.killSwitch })
    if (res.ok) refreshState()
  })

  document.getElementById("dryBtn").addEventListener("click", async () => {
    const s = getState()
    if (!s) return
    const res = await auth("/api/dry-run", { enabled: !s.dryRun })
    if (res.ok) refreshState()
  })

  onState(render)
}

function render(s) {
  const dryBtn = document.getElementById("dryBtn")
  dryBtn.classList.toggle("dry-on", !!s.dryRun)
  dryBtn.textContent = "dry-run: " + (s.dryRun ? "on" : "off")
  const killBtn = document.getElementById("killBtn")
  killBtn.classList.toggle("engaged", !!s.killSwitch)
  killBtn.textContent = "kill switch: " + (s.killSwitch ? "engaged" : "off")
}
