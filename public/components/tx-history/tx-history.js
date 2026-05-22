/**
 * Tx history — chronological list of broadcast events with explorer links.
 * Filters out confirmation follow-ups so each tx appears once.
 */

import { onState, fmt } from "/js/core.js"

export function init() { onState(render) }

function render(s) {
  const events = s.events || []
  const txs = events.filter((e) => e.txHash && e.action !== "confirm")
  const tw = document.getElementById("txWrap")
  if (txs.length === 0) {
    tw.innerHTML = '<div class="empty">no broadcast txs yet</div>'
    return
  }
  let h = "<table><thead><tr><th>time</th><th>action</th><th>tx</th></tr></thead><tbody>"
  for (const e of txs.slice(0, 20)) {
    const act = e.action === "open_long" ? "LONG"
      : e.action === "open_short" ? "SHORT"
      : e.action === "close" ? "CLOSE"
      : e.action.toUpperCase()
    h += "<tr>"
    h += "<td>" + fmt.time(e.ts) + "</td>"
    h += "<td>" + act + "</td>"
    h += '<td><a href="' + (e.explorer || "#") + '" target="_blank">' + e.txHash.slice(0, 10) + "…</a></td>"
    h += "</tr>"
  }
  h += "</tbody></table>"
  tw.innerHTML = h
}
