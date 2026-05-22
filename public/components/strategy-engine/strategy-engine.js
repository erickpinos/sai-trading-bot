/**
 * Built-in strategy engine component.
 *
 * UI for spinning up oracle-driven strategies that run inside the bot
 * (no TradingView required). Lists running strategies, lets the operator
 * start/stop them, and reflects their live state (warmup, signal, errors)
 * from /api/state.strategies.
 */

import { onState, onMarkets, auth, refreshState, fmt, escapeHtml } from "/js/core.js"

let catalog = []
let markets = []

export async function init() {
  await loadCatalog()
  wireHandlers()

  onMarkets((ms) => {
    markets = ms
    populateMarketSelect()
  })

  onState(render)
}

async function loadCatalog() {
  try {
    const r = await fetch("/api/strategies/catalog", { cache: "no-store" })
    const j = await r.json()
    catalog = j.catalog || []
  } catch {
    catalog = []
  }
  populateTypeSelect()
  renderParamsForCurrentType()
}

function populateTypeSelect() {
  const sel = document.getElementById("seType")
  sel.innerHTML = ""
  if (catalog.length === 0) {
    sel.innerHTML = '<option value="">no strategies available</option>'
    return
  }
  for (const c of catalog) {
    const opt = document.createElement("option")
    opt.value = c.type
    opt.textContent = c.label
    sel.appendChild(opt)
  }
  const saved = localStorage.getItem("seType")
  if (saved && catalog.some((c) => c.type === saved)) sel.value = saved
}

function populateMarketSelect() {
  const sel = document.getElementById("seMarket")
  const cur = sel.value || localStorage.getItem("seMarketId") || ""
  sel.innerHTML = ""
  if (markets.length === 0) {
    sel.innerHTML = '<option value="">no open markets</option>'
    return
  }
  const sorted = markets.slice().sort((a, b) => (a.base || "").localeCompare(b.base || ""))
  for (const m of sorted) {
    const opt = document.createElement("option")
    opt.value = String(m.marketId)
    const px = typeof m.price === "number"
      ? (m.price < 1 ? m.price.toPrecision(4) : m.price.toFixed(2))
      : "?"
    opt.textContent = m.base + "/" + m.quote + " · #" + m.marketId + " · $" + px
    sel.appendChild(opt)
  }
  if (cur && sorted.some((m) => String(m.marketId) === cur)) sel.value = cur
}

function currentCatalogEntry() {
  const t = document.getElementById("seType").value
  return catalog.find((c) => c.type === t)
}

function renderParamsForCurrentType() {
  const entry = currentCatalogEntry()
  const host = document.getElementById("seParams")
  const desc = document.getElementById("seDesc")
  host.innerHTML = ""
  if (!entry) {
    desc.textContent = "—"
    return
  }
  desc.textContent = entry.description
  for (const p of entry.params) {
    const row = document.createElement("div")
    row.className = "form-row"
    const label = document.createElement("label")
    label.textContent = p.label
    const input = document.createElement("input")
    input.type = "number"
    input.id = "seParam_" + p.key
    input.value = String(p.default)
    if (p.step != null) input.step = String(p.step)
    if (p.min != null) input.min = String(p.min)
    row.appendChild(label)
    row.appendChild(input)
    host.appendChild(row)
  }
}

function wireHandlers() {
  document.getElementById("seType").addEventListener("change", () => {
    localStorage.setItem("seType", document.getElementById("seType").value)
    renderParamsForCurrentType()
  })
  document.getElementById("seMarket").addEventListener("change", () => {
    const id = document.getElementById("seMarket").value
    if (id) localStorage.setItem("seMarketId", id)
  })
  document.getElementById("seStart").addEventListener("click", onStartClick)
  document.getElementById("seRunning").addEventListener("click", onRunningClick)
}

async function onStartClick() {
  const errEl = document.getElementById("seError")
  errEl.style.display = "none"
  const entry = currentCatalogEntry()
  if (!entry) return
  const marketId = Number(document.getElementById("seMarket").value)
  if (!Number.isFinite(marketId)) {
    return showError("pick a market first")
  }
  const intervalSec = Number(document.getElementById("seInterval").value)
  const leverage = Number(document.getElementById("seLev").value)
  const amountUsdc = String(document.getElementById("seAmt").value || "5")
  const slippagePct = String(document.getElementById("seSlp").value || "1")

  const params = {}
  for (const p of entry.params) {
    const v = Number(document.getElementById("seParam_" + p.key).value)
    if (Number.isFinite(v)) params[p.key] = v
  }

  const btn = document.getElementById("seStart")
  btn.disabled = true
  btn.textContent = "starting…"
  try {
    const res = await auth("/api/strategies/start", {
      type: entry.type,
      marketId,
      intervalSec,
      leverage,
      amountUsdc,
      slippagePct,
      params,
    })
    if (!res.ok) {
      const msg = res.json?.message || res.json?.error || "request failed"
      showError(msg)
    } else {
      refreshState()
    }
  } catch (e) {
    showError(e.message)
  } finally {
    btn.disabled = false
    btn.textContent = "start strategy"
  }
}

async function onRunningClick(e) {
  const btn = e.target.closest("button[data-stop]")
  if (!btn) return
  const id = btn.dataset.stop
  btn.disabled = true
  await auth("/api/strategies/stop", { id })
  refreshState()
}

function showError(msg) {
  const el = document.getElementById("seError")
  el.textContent = msg
  el.style.display = ""
}

function render(state) {
  const list = (state && state.strategies) || []
  const countEl = document.getElementById("seCount")
  countEl.textContent = list.length === 0 ? "0 running" : list.length + " running"
  countEl.className = "pill " + (list.length > 0 ? "active" : "idle")

  const host = document.getElementById("seRunning")
  if (list.length === 0) {
    host.innerHTML = '<div class="empty">none</div>'
    return
  }
  let h = "<table><thead><tr>"
  h += "<th>id</th><th>type</th><th>mkt</th><th>signal</th><th>px</th><th>ticks</th><th>last</th><th></th>"
  h += "</tr></thead><tbody>"
  for (const s of list) {
    const signal = s.lastSignal || "—"
    const sigPill = signal === "long" ? "long" : signal === "short" ? "short" : "idle"
    const warmup = s.warmedUp ? "" : ` <span class="pill amber" style="background:var(--amber-bg);color:var(--amber)">warm ${s.bufferLen}/${s.warmupNeeded}</span>`
    const last = s.lastTickAt ? fmt.rel(s.lastTickAt) : "—"
    const px = s.lastPrice == null ? "—" : (s.lastPrice < 1 ? s.lastPrice.toPrecision(4) : s.lastPrice.toFixed(2))
    h += "<tr>"
    h += "<td>" + escapeHtml(s.id) + "</td>"
    h += "<td>" + escapeHtml(s.type) + "</td>"
    h += "<td>#" + s.marketId + "</td>"
    h += '<td><span class="pill ' + sigPill + '">' + signal + "</span>" + warmup + "</td>"
    h += "<td>" + px + "</td>"
    h += "<td>" + s.tickCount + "</td>"
    h += '<td title="' + (s.lastError ? escapeHtml(s.lastError) : "") + '">' + last + (s.lastError ? ' <span class="pill error">err</span>' : "") + "</td>"
    h += '<td><button class="btn sm" data-stop="' + escapeHtml(s.id) + '">stop</button></td>'
    h += "</tr>"
  }
  h += "</tbody></table>"
  host.innerHTML = h
}
