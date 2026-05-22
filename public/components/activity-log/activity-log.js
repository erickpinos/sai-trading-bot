/**
 * Activity log — the rolling table of recent webhook / strategy events in
 * the middle column.
 */

import { onState, auth, refreshState, fmt } from "/js/core.js"

export function init() {
  document.getElementById("clearBtn").addEventListener("click", async () => {
    const res = await auth("/api/clear-events", {})
    if (res.ok) refreshState()
  })
  onState(render)
}

function render(s) {
  const events = s.events || []
  const ew = document.getElementById("eventsWrap")
  if (events.length === 0) {
    ew.innerHTML = '<div class="empty">no signals yet</div>'
    return
  }
  let h = "<table><thead><tr>"
  h += "<th>time</th><th>act</th><th>market</th><th>status</th><th>dur</th>"
  h += "</tr></thead><tbody>"
  for (const e of events.slice(0, 25)) {
    const sideLbl = e.action === "open_long" ? "LONG"
      : e.action === "open_short" ? "SHORT"
      : e.action === "close" ? "CLOSE"
      : e.action === "confirm" ? "CONFIRM"
      : e.action.toUpperCase()
    const sidePill = e.action === "open_long" ? "long"
      : e.action === "open_short" ? "short" : ""
    const market = e.base && e.quote ? (e.base + "/" + e.quote)
      : e.marketId !== undefined ? ("m" + e.marketId) : "—"
    h += "<tr>"
    h += "<td>" + fmt.time(e.ts) + "</td>"
    h += '<td>' + (sidePill ? '<span class="pill ' + sidePill + '">' + sideLbl + "</span>" : sideLbl) + "</td>"
    h += "<td>" + market + "</td>"
    h += '<td><span class="pill ' + e.status + '">' + e.status + "</span></td>"
    h += "<td>" + (e.durationMs !== undefined ? e.durationMs + "ms" : "—") + "</td>"
    h += "</tr>"
  }
  h += "</tbody></table>"
  ew.innerHTML = h
}
