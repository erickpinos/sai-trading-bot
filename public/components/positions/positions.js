/**
 * Open positions table with click-to-sort column headers and a localStorage-
 * persisted sort preference.
 */

import { onState, fmt, escapeHtml, getState } from "/js/core.js"

const SORT_KEY = "saitb_pos_sort_v1"

let posSort
try { posSort = JSON.parse(localStorage.getItem(SORT_KEY) || "") || { col: "pnlPct", dir: "desc" } }
catch { posSort = { col: "pnlPct", dir: "desc" } }

const SORT_GETTERS = {
  pair: (p) => (p.base || "") + "/" + (p.quote || ""),
  side: (p) => (p.long ? 1 : 0),
  leverage: (p) => Number(p.leverage),
  collateralUsdc: (p) => p.collateralUsdc,
  openPrice: (p) => p.openPrice,
  markPrice: (p) => p.markPrice,
  pnlPct: (p) => p.pnlPct,
  feesUsdc: (p) => p.feesUsdc,
  liquidationPrice: (p) => p.liquidationPrice,
  openedAt: (p) => (p.openedAt ? Date.parse(p.openedAt) : 0),
}

function sortPositions(positions) {
  const getter = SORT_GETTERS[posSort.col] || SORT_GETTERS.pnlPct
  const dir = posSort.dir === "desc" ? -1 : 1
  return positions.slice().sort((a, b) => {
    const va = getter(a), vb = getter(b)
    if (typeof va === "string") return va.localeCompare(vb) * dir
    return ((va ?? -Infinity) - (vb ?? -Infinity)) * dir
  })
}

export function init() {
  document.getElementById("positionsWrap").addEventListener("click", (e) => {
    const th = e.target.closest && e.target.closest("th.sortable")
    if (!th) return
    const col = th.dataset.sort
    if (!col) return
    if (posSort.col === col) {
      posSort.dir = posSort.dir === "desc" ? "asc" : "desc"
    } else {
      posSort.col = col
      posSort.dir = col === "pair" ? "asc" : "desc"
    }
    localStorage.setItem(SORT_KEY, JSON.stringify(posSort))
    const s = getState()
    if (s) render(s)
  })
  onState(render)
}

function render(s) {
  const pw = document.getElementById("positionsWrap")
  let html = ""
  if (s.positionsWarning) html += '<div class="warn">' + escapeHtml(s.positionsWarning) + "</div>"
  if (!s.positions || s.positions.length === 0) {
    html += '<div class="empty">no open positions</div>'
    pw.innerHTML = html
    return
  }
  const sorted = sortPositions(s.positions)
  const arrow = (k) =>
    posSort.col === k
      ? '<span class="arrow">' + (posSort.dir === "desc" ? "▼" : "▲") + "</span>"
      : '<span class="arrow">▾</span>'
  const th = (k, label) =>
    '<th class="sortable' + (posSort.col === k ? " active" : "") +
    '" data-sort="' + k + '">' + label + arrow(k) + "</th>"
  html += "<table><thead><tr>"
  html += th("pair", "pair") + th("side", "side") + th("leverage", "lev")
  html += th("collateralUsdc", "coll") + th("openPrice", "entry") + th("markPrice", "mark")
  html += th("pnlPct", "pnl") + th("feesUsdc", "fees") + th("liquidationPrice", "liq") + th("openedAt", "opened")
  html += "</tr></thead><tbody>"
  for (const p of sorted) {
    const pair = p.base && p.quote ? (p.base + "/" + p.quote) : ("m" + p.marketId)
    const pnlCls = p.pnlUsdc === null ? "pnl-zero" : p.pnlUsdc > 0 ? "pnl-pos" : p.pnlUsdc < 0 ? "pnl-neg" : "pnl-zero"
    const pnlStr = p.pnlUsdc === null
      ? "—"
      : (p.pnlUsdc >= 0 ? "+" : "") + p.pnlUsdc.toFixed(2)
    const pnlPctStr = p.pnlPct === null
      ? ""
      : " (" + (p.pnlPct >= 0 ? "+" : "") + p.pnlPct.toFixed(1) + "%)"
    const openedMs = p.openedAt ? Date.parse(p.openedAt) : null
    const openedRel = openedMs ? fmt.rel(openedMs) : "—"
    const openedTitle = p.openedAt ? new Date(p.openedAt).toLocaleString() : ""
    html += "<tr>"
    html += "<td>" + pair + " <span style='color:var(--dim);font-size:10px'>#" + p.id + "</span></td>"
    html += '<td><span class="pill ' + (p.long ? "long" : "short") + '">' + (p.long ? "L" : "S") + "</span></td>"
    html += "<td>" + p.leverage + "x</td>"
    html += "<td>" + fmt.num(p.collateralUsdc, 2) + "</td>"
    html += "<td>" + fmt.num(p.openPrice, 2) + "</td>"
    html += "<td>" + fmt.num(p.markPrice, 2) + "</td>"
    html += '<td class="' + pnlCls + '">' + pnlStr + pnlPctStr + "</td>"
    const feesStr = p.feesUsdc === null || p.feesUsdc === undefined
      ? "—"
      : "-" + p.feesUsdc.toFixed(4)
    const feesTitle = p.borrowingFeeUsdc !== null && p.borrowingFeeUsdc !== undefined
      ? "borrowing: " + p.borrowingFeeUsdc.toFixed(4) + " · closing: " + (p.closingFeeUsdc ?? 0).toFixed(4)
      : ""
    html += '<td title="' + escapeHtml(feesTitle) + '" class="pnl-neg">' + feesStr + "</td>"
    html += "<td>" + fmt.num(p.liquidationPrice, 2) + "</td>"
    html += '<td title="' + escapeHtml(openedTitle) + '" style="color:var(--dim)">' + openedRel + "</td>"
    html += "</tr>"
  }
  html += "</tbody></table>"
  pw.innerHTML = html
}
