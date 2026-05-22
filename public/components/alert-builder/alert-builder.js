/**
 * Alert-builder component
 *
 * Owns:
 *  - market picker + per-market metadata pill
 *  - leverage/collateral/slippage inputs
 *  - the tunnel start/stop toolbar that sits under the webhook URL
 *  - the four TradingView code blocks (URL + strategy/open_long/open_short/close JSON)
 *
 * Reads global state via core.onState + core.onMarkets and renders the URL
 * + tunnel pill from there. All mutations (tunnel start/stop) go through
 * core.auth() which prompts for the WEBHOOK_SECRET when needed.
 */

import {
  onState, onMarkets, auth, refreshState, setCode, wireCopy,
} from "/js/core.js"

let marketCache = []
let latestState = null

export function init() {
  populateInputs()
  wireInputHandlers()
  wireTunnelButton()
  renderWebhookSnippets()

  onMarkets((ms) => {
    marketCache = ms
    populateMarketSelect(ms)
    renderTargetMeta(currentMarket())
    renderWebhookSnippets()
  })

  onState((s) => {
    latestState = s
    renderTunnel(s)
    renderWebhookSnippets()
    // Wire copy buttons on any new .code-block elements that don't have one yet
    // (the per-snippet setters add their own, this catches edge cases).
    for (const el of document.querySelectorAll("#alertBuilder .code-block[data-copy]")) {
      if (el.querySelector(".copy-btn")) continue
      wireCopy(el, el.textContent || "")
    }
  })
}

function populateInputs() {
  // Restore last-selected market once markets land via onMarkets.
}

function wireInputHandlers() {
  document.getElementById("marketSel").addEventListener("change", () => {
    const id = document.getElementById("marketSel").value
    if (id) localStorage.setItem("targetMarketId", id)
    renderTargetMeta(currentMarket())
    renderWebhookSnippets()
  })
  for (const id of ["ambLev", "ambAmt", "ambSlp"]) {
    document.getElementById(id).addEventListener("input", renderWebhookSnippets)
  }
}

function wireTunnelButton() {
  document.getElementById("tunnelBtn").addEventListener("click", async () => {
    if (!latestState) return
    const t = latestState.tunnel || { status: "stopped" }
    const stopping = t.status === "running"
    const path = stopping ? "/api/tunnel/stop" : "/api/tunnel/start"

    // Optimistic UI: swap button + pill before the network round-trip so
    // the click feels instant. The next /api/state poll will overwrite this
    // with the real state.
    const btn = document.getElementById("tunnelBtn")
    const pill = document.getElementById("tunnelPill")
    btn.disabled = true
    btn.textContent = stopping ? "stopping…" : "starting…"
    pill.className = "pill " + (stopping ? "stopped" : "starting")
    pill.textContent = stopping ? "stopping" : "starting"

    const res = await auth(path, {})
    if (res.ok) refreshState()
    else btn.disabled = false
  })
}

function populateMarketSelect(ms) {
  const sel = document.getElementById("marketSel")
  const cur = sel.value || localStorage.getItem("targetMarketId") || ""
  sel.innerHTML = ""
  if (ms.length === 0) {
    sel.innerHTML = '<option value="">no open markets</option>'
    return
  }
  const sorted = ms.slice().sort((a, b) => (a.base || "").localeCompare(b.base || ""))
  for (const m of sorted) {
    const opt = document.createElement("option")
    opt.value = String(m.marketId)
    const px = typeof m.price === "number"
      ? (m.price < 1 ? m.price.toPrecision(4) : m.price.toFixed(2))
      : "?"
    opt.textContent = m.base + "/" + m.quote + " · #" + m.marketId + " · $" + px + " · " + m.maxLeverage + "x max"
    sel.appendChild(opt)
  }
  if (cur && sorted.some((m) => String(m.marketId) === cur)) sel.value = cur
}

function currentMarket() {
  const id = document.getElementById("marketSel").value
  if (!id) return null
  return marketCache.find((m) => String(m.marketId) === id) || null
}

function renderTargetMeta(m) {
  const pill = document.getElementById("targetPill")
  const idEl = document.getElementById("targetId")
  const pxEl = document.getElementById("targetPx")
  const lvEl = document.getElementById("targetMaxLev")
  if (!m) {
    pill.textContent = "—"; pill.className = "pill idle"
    idEl.textContent = "—"; pxEl.textContent = "—"; lvEl.textContent = "—"
    return
  }
  pill.textContent = m.base + "/" + m.quote
  pill.className = "pill active"
  idEl.textContent = String(m.marketId)
  pxEl.textContent = typeof m.price === "number"
    ? "$" + (m.price < 1 ? m.price.toPrecision(4) : m.price.toFixed(2))
    : "—"
  lvEl.textContent = m.maxLeverage + "x"
}

function ambInputs() {
  const m = currentMarket()
  const marketId = m ? m.marketId : 0
  const lev = Number(document.getElementById("ambLev").value) || 2
  const amt = String(document.getElementById("ambAmt").value || "5")
  const slp = String(document.getElementById("ambSlp").value || "1")
  return { marketId, lev, amt, slp }
}

function renderWebhookSnippets() {
  const { marketId, lev, amt, slp } = ambInputs()
  setCode("tvStrategy", JSON.stringify({
    secret: "<YOUR_WEBHOOK_SECRET>", action: "strategy",
    marketId, leverage: lev, amountUsdc: amt, slippagePct: slp,
    orderAction: "{{strategy.order.action}}",
    marketPosition: "{{strategy.market_position}}",
  }, null, 2))
  setCode("tvOpenLong", JSON.stringify({
    secret: "<YOUR_WEBHOOK_SECRET>", action: "open_long",
    marketId, leverage: lev, amountUsdc: amt, slippagePct: slp,
  }, null, 2))
  setCode("tvOpenShort", JSON.stringify({
    secret: "<YOUR_WEBHOOK_SECRET>", action: "open_short",
    marketId, leverage: lev, amountUsdc: amt, slippagePct: slp,
  }, null, 2))
  setCode("tvCloseByIndex", JSON.stringify({
    secret: "<YOUR_WEBHOOK_SECRET>", action: "close",
    userTradeIndex: 42,
  }, null, 2))
}

function renderTunnel(s) {
  const bar = document.querySelector(".tunnel-bar")
  const pill = document.getElementById("tunnelPill")
  const msg = document.getElementById("tunnelMsg")
  const btn = document.getElementById("tunnelBtn")
  const t = s.tunnel || { status: "stopped", url: null, error: null }

  // The URL code block only exists while the tunnel is actually serving
  // traffic. The label above stays so the operator knows what's missing.
  const urlEl = document.getElementById("tvUrl")
  if (t.status === "running" && t.url) {
    urlEl.style.display = ""
    setCode("tvUrl", s.webhookUrl)
  } else {
    urlEl.style.display = "none"
  }

  // One button toggles between start and stop based on current status; the
  // tunnel-bar that hosts it is always visible.
  bar.style.display = ""
  btn.style.display = ""
  pill.className = "pill " + t.status
  pill.textContent = t.status
  msg.classList.remove("error")
  btn.classList.remove("red")

  if (t.status === "running") {
    btn.disabled = false
    btn.textContent = "stop tunnel"
    msg.style.display = "none"
    msg.textContent = ""
  } else if (t.status === "starting") {
    btn.disabled = true
    btn.textContent = "starting…"
    msg.style.display = "none"
    msg.textContent = ""
  } else if (t.status === "error") {
    btn.disabled = false
    btn.textContent = "retry tunnel"
    msg.classList.add("error")
    msg.style.display = ""
    msg.textContent = "tunnel error: " + (t.error || "unknown")
  } else {
    btn.disabled = false
    btn.textContent = "start tunnel"
    msg.style.display = "none"
    msg.textContent = ""
  }
}
